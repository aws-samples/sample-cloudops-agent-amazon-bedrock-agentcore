import React, { createContext, useContext, useReducer, useRef, useCallback } from 'react';
import { chatReducer, initialChatState } from '@/state/chatReducer';
import { invokeAgent } from '@/services/agentCore';
import { getOrCreateSession, resetSession } from '@/services/session';
import { getAppConfig } from '@/services/config';
import { Message, AgentCredentials } from '@/types';
import { appendMessages } from '@/services/conversationService';
import { fetchAuthSession } from 'aws-amplify/auth';
import { v4 as uuidv4 } from 'uuid';

interface ChatContextValue {
  messages: Message[];
  isLoading: boolean;
  progressMessage: string | null;
  error: { message: string; originalPrompt: string } | null;
  saveError: string | null;
  sessionId: string;
  sendMessage: (content: string, credentials: AgentCredentials) => void;
  retryMessage: (credentials: AgentCredentials) => void;
  clearMessages: () => void;
  cancelRequest: () => void;
  setMessages: (messages: Message[]) => void;
  setSessionId: (id: string) => void;
  dismissSaveError: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

const REQUEST_TIMEOUT_MS = 60000;

async function getAuthToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() || null;
  } catch {
    return null;
  }
}

/**
 * Resolves the Cognito token forwarded to the Agent Runtime for role-based
 * authorization. The `role` claim is injected into both the access and ID
 * tokens by the Pre Token Generation Lambda; the access token is the one the
 * Gateway's CUSTOM_JWT authorizer validates, with the ID token as a fallback.
 */
async function getRuntimeToken(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return (
      session.tokens?.accessToken?.toString() ||
      session.tokens?.idToken?.toString() ||
      null
    );
  } catch {
    return null;
  }
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  // Map of conversationId → AbortController for in-flight requests
  // This allows multiple concurrent requests (one per conversation)
  const activeRequestsRef = useRef<Map<string, AbortController>>(new Map());
  const sessionIdRef = useRef<string>(getOrCreateSession());

  const cancelRequest = useCallback(() => {
    // Cancel only the current conversation's request
    const currentId = sessionIdRef.current;
    const controller = activeRequestsRef.current.get(currentId);
    if (controller) {
      controller.abort();
      activeRequestsRef.current.delete(currentId);
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string, credentials: AgentCredentials) => {
      // Capture the conversation this request belongs to AT SEND TIME
      const targetConversationId = sessionIdRef.current;

      // Req 7.5: If there is no authenticated identity, the SPA must NOT invoke
      // the Agent Runtime. Resolve the user's Cognito token up front; when none
      // can be resolved (no Cognito session/token), surface an auth-required
      // error and bail out before mutating chat state or calling the runtime.
      // The originalPrompt is preserved so the user can retry after signing in.
      const runtimeToken = await getRuntimeToken();
      if (!runtimeToken) {
        dispatch({
          type: 'SET_ERROR',
          payload: {
            message: 'You must be signed in to send a message. Please sign in and try again.',
            originalPrompt: content,
          },
        });
        return;
      }

      // Only abort if there's already a request for THIS conversation
      const existingController = activeRequestsRef.current.get(targetConversationId);
      if (existingController) {
        existingController.abort();
        activeRequestsRef.current.delete(targetConversationId);
      }

      // Create the user message
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content,
        timestamp: Date.now(),
        status: 'sent',
      };

      dispatch({ type: 'SEND_MESSAGE', payload: { content } });

      // Save user message to API immediately
      const token = await getAuthToken();
      if (token && targetConversationId) {
        appendMessages(token, targetConversationId, [userMessage]).catch(() => {
          // Persisting to conversation history failed. Surface it as a
          // non-blocking notice (issue #19) rather than swallowing it, so the
          // user is not misled into thinking the exchange was saved.
          dispatch({
            type: 'SET_SAVE_ERROR',
            payload:
              'Your message was sent, but saving it to conversation history failed. It may not appear after reloading.',
          });
        });
      }

      const controller = new AbortController();
      activeRequestsRef.current.set(targetConversationId, controller);
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const config = getAppConfig();
        const result = await invokeAgent(
          content,
          targetConversationId,
          config,
          credentials,
          runtimeToken,
          controller.signal
        );

        // Create agent message
        const agentMessage: Message = {
          id: uuidv4(),
          role: 'agent',
          content: result,
          timestamp: Date.now(),
          status: 'delivered',
        };

        // Check if user is still on the same conversation
        if (sessionIdRef.current === targetConversationId) {
          // Same conversation — show response in UI
          dispatch({ type: 'RECEIVE_MESSAGE', payload: { content: result } });
        } else {
          // User switched away — don't touch UI state (they're viewing a different conversation)
          // The response is still saved below to the correct conversation
        }

        // Save agent response to API (always save to TARGET conversation)
        const saveToken = await getAuthToken();
        if (saveToken && targetConversationId) {
          appendMessages(saveToken, targetConversationId, [agentMessage]).catch(() => {
            // Only surface the save failure if the user is still viewing this
            // conversation; otherwise it would be misattributed to whatever
            // conversation they switched to. The failure is still real, but the
            // notice is only meaningful in-context (issue #19).
            if (sessionIdRef.current === targetConversationId) {
              dispatch({
                type: 'SET_SAVE_ERROR',
                payload:
                  'The response was received, but saving it to conversation history failed. It may not appear after reloading.',
              });
            }
          });
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Only clear loading if still on same conversation
          if (sessionIdRef.current === targetConversationId) {
            dispatch({ type: 'SET_LOADING', payload: false });
          }
          return;
        }

        // Only show error in UI if still on same conversation
        if (sessionIdRef.current === targetConversationId) {
          const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
          dispatch({
            type: 'SET_ERROR',
            payload: { message, originalPrompt: content },
          });
        }
      } finally {
        clearTimeout(timeoutId);
        activeRequestsRef.current.delete(targetConversationId);
      }
    },
    []
  );

  const retryMessage = useCallback(
    (credentials: AgentCredentials) => {
      if (!state.error?.originalPrompt) return;
      const originalPrompt = state.error.originalPrompt;
      sendMessage(originalPrompt, credentials);
    },
    [state.error, sendMessage]
  );

  const clearMessages = useCallback(() => {
    cancelRequest();
    sessionIdRef.current = resetSession();
    dispatch({ type: 'CLEAR_MESSAGES' });
  }, [cancelRequest]);

  const setMessages = useCallback((messages: Message[]) => {
    dispatch({ type: 'SET_MESSAGES', payload: messages });
  }, []);

  const setSessionId = useCallback((id: string) => {
    sessionIdRef.current = id;
  }, []);

  const dismissSaveError = useCallback(() => {
    dispatch({ type: 'SET_SAVE_ERROR', payload: null });
  }, []);

  const value: ChatContextValue = {
    messages: state.messages,
    isLoading: state.isLoading,
    progressMessage: state.progressMessage,
    error: state.error,
    saveError: state.saveError,
    sessionId: sessionIdRef.current,
    sendMessage,
    retryMessage,
    clearMessages,
    cancelRequest,
    setMessages,
    setSessionId,
    dismissSaveError,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error('useChatContext must be used within a ChatProvider');
  }
  return context;
}
