import React, { createContext, useContext, useReducer, useRef, useCallback, useEffect } from 'react';
import { chatReducer, initialChatState } from '@/state/chatReducer';
import { invokeAgent } from '@/services/agentCore';
import { AgentStreamError } from '@/services/agentStream';
import { getOrCreateSession, resetSession } from '@/services/session';
import { getAppConfig } from '@/services/config';
import type { Message, AgentCredentials, MessagePart, ToolPart, ChatState, ChatAction, ConversationMetadata } from '@/types';
import { parsePresentation } from '@/components/tool-ui/schema';
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
  sendMessage: (content: string, credentials: AgentCredentials) => Promise<void>;
  retryMessage: (credentials: AgentCredentials) => void;
  clearMessages: () => void;
  cancelRequest: () => void;
  setMessages: (messages: Message[]) => void;
  setSessionId: (id: string) => void;
  forgetConversation: (id: string) => void;
  dismissSaveError: () => void;
}

const ChatContext = createContext<ChatContextValue | undefined>(undefined);
// Let the model's 120s read timeout surface first; reset on real stream events.
const IDLE_TIMEOUT_MS = 130_000;
const MAX_RUN_MS = 600_000;

export function ChatProvider({ children, onConversationSaved }: {
  children: React.ReactNode;
  onConversationSaved?: (conversation: ConversationMetadata) => void;
}) {
  // Application-owned store. The library adapter reads the selected conversation;
  // requests always update the conversation captured at send time.
  const conversations = useRef(new Map<string, ChatState>());
  const activeRequests = useRef(new Map<string, AbortController>());
  const pendingSaves = useRef(new Map<string, Promise<void>>());
  const deleted = useRef(new Set<string>());
  const sessionId = useRef(getOrCreateSession());
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequests.current.forEach(controller => controller.abort());
      activeRequests.current.clear();
    };
  }, []);

  const update = useCallback((id: string, action: ChatAction) => {
    if (!mounted.current || deleted.current.has(id)) return;
    const state = conversations.current.get(id) ?? initialChatState;
    conversations.current.set(id, chatReducer(state, action));
    if (sessionId.current === id) refresh();
  }, []);

  const cancelRequest = useCallback(() => {
    activeRequests.current.get(sessionId.current)?.abort();
  }, []);

  const sendMessage = useCallback(async (content: string, credentials: AgentCredentials) => {
    const target = sessionId.current;
    if (!content.trim() || deleted.current.has(target) || activeRequests.current.has(target)) return;
    // Reserve before authentication awaits so double submits cannot start two runs.
    const controller = new AbortController();
    activeRequests.current.set(target, controller);
    const ownsRun = () => mounted.current && !deleted.current.has(target) && activeRequests.current.get(target) === controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut: 'idle' | 'total' | undefined;
    const expire = (reason: 'idle' | 'total') => { timedOut = reason; controller.abort(); };
    const resetIdleTimer = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => expire('idle'), IDLE_TIMEOUT_MS);
    };
    let answer: Message | undefined;
    let saveQueue = Promise.resolve();

    const save = (message: Message) => {
      // Serialize snapshots across runs without keeping execution locked while
      // history is slow. A deleted conversation or unmounted user never writes.
      const canSave = () => mounted.current && !deleted.current.has(target);
      saveQueue = (pendingSaves.current.get(target) ?? Promise.resolve()).then(async () => {
        if (!canSave()) return;
        try {
          const session = await fetchAuthSession();
          const token = session.tokens?.idToken?.toString();
          if (!token) throw new Error('Authentication required');
          if (!canSave()) return;
          const saved = await appendMessages(token, target, [message]);
          if (canSave() && saved) onConversationSaved?.(saved);
        } catch {
          update(target, { type: 'SET_SAVE_ERROR', payload: 'Saving to conversation history failed. This exchange may not appear after reloading.' });
        }
      });
      pendingSaves.current.set(target, saveQueue);
    };

    try {
      let runtimeToken: string | undefined;
      try {
        const session = await fetchAuthSession();
        // Gateway validates the access token's role claim; retain the ID-token
        // fallback for compatibility. Never derive identity from client role fields.
        runtimeToken = session.tokens?.accessToken?.toString() || session.tokens?.idToken?.toString();
      } catch { /* The identity guard below fails closed. */ }
      if (!ownsRun() || controller.signal.aborted) return;
      if (!runtimeToken) {
        update(target, { type: 'SET_ERROR', payload: { message: 'You must be signed in to send a message. Please sign in and try again.', originalPrompt: content } });
        return;
      }

      const userMessage: Message = { id: uuidv4(), role: 'user', content, timestamp: Date.now(), status: 'sent' };
      update(target, { type: 'SET_ERROR', payload: null });
      update(target, { type: 'SET_SAVE_ERROR', payload: null });
      update(target, { type: 'UPSERT_MESSAGE', payload: userMessage });
      update(target, { type: 'SET_LOADING', payload: true });
      update(target, { type: 'SET_PROGRESS', payload: 'Connecting to the agent' });
      save(userMessage);
      answer = { id: uuidv4(), role: 'agent', content: '', timestamp: Date.now(), status: 'streaming', partsVersion: 1, parts: [] };
      resetIdleTimer();
      deadline = setTimeout(() => expire('total'), MAX_RUN_MS);

      const result = await invokeAgent(content, target, getAppConfig(), credentials, runtimeToken, controller.signal, event => {
        if (!ownsRun() || controller.signal.aborted || !answer) return;
        resetIdleTimer();
        if (event.type === 'run-stage') {
          const labels = {
            'discovering-tools': 'Checking available tools',
            'waiting-model': 'Waiting for the model',
            'model-retry': 'Model is busy. Waiting to retry',
          };
          update(target, { type: 'SET_PROGRESS', payload: labels[event.stage!] });
          return;
        }
        const parts: MessagePart[] = [...answer.parts!];
        if (event.type === 'text-delta') {
          const last = parts[parts.length - 1];
          if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: last.text + event.text };
          else parts.push({ type: 'text', text: event.text! });
          answer = { ...answer, content: answer.content + event.text, parts };
          update(target, { type: 'SET_PROGRESS', payload: 'Receiving the response' });
        } else if (event.type.startsWith('tool-')) {
          const tool: ToolPart = {
            type: 'tool', toolCallId: event.toolCallId!, toolName: event.toolName!,
            status: event.type === 'tool-start' ? 'running'
              : event.code === 'access-denied' || event.code === 'capability-unavailable' ? 'blocked'
                : event.code === 'tool-unavailable' ? 'unavailable'
                  : event.type === 'tool-error' ? 'failed' : 'completed',
            presentation: parsePresentation(event.presentation),
            output: event.output,
          };
          const index = parts.findIndex(part => part.type === 'tool' && part.toolCallId === tool.toolCallId);
          if (index < 0) parts.push(tool);
          else parts[index] = tool;
          answer = { ...answer, parts };
          update(target, { type: 'SET_PROGRESS', payload: event.type === 'tool-start' ? 'Running the requested tool' : 'Waiting for the model' });
        }
        update(target, { type: 'UPSERT_MESSAGE', payload: answer });
      });
      if (!ownsRun() || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      answer = { ...answer, content: result, status: 'delivered', parts: answer.parts!.length ? answer.parts : [{ type: 'text', text: result }] };
      update(target, { type: 'UPSERT_MESSAGE', payload: answer });
      save(answer);
    } catch (error: unknown) {
      if (!ownsRun()) return;
      if (answer && error instanceof AgentStreamError && error.code === 'access-denied') {
        answer = {
          ...answer, status: 'restricted',
          content: answer.content || 'Access restricted. Your current access does not allow this action.',
          parts: answer.parts?.map(part => part.type === 'tool' && part.status === 'running' ? { ...part, status: 'blocked' } : part),
        };
        update(target, { type: 'UPSERT_MESSAGE', payload: answer });
        save(answer);
        return;
      }
      if (answer) {
        answer = { ...answer, status: 'interrupted', parts: answer.parts?.map(part => part.type === 'tool' && part.status === 'running' ? { ...part, status: 'interrupted' } : part) };
        update(target, { type: 'UPSERT_MESSAGE', payload: answer });
      }
      if (!controller.signal.aborted || timedOut) {
        update(target, { type: 'SET_ERROR', payload: {
          message: timedOut === 'total'
            ? 'The investigation reached the 10-minute time limit. You can retry; remote execution may still be running.'
            : timedOut === 'idle'
              ? 'No new response was received for 130 seconds. You can retry; remote execution may still be running.'
              : error instanceof Error ? error.message : 'The investigation could not finish. Please retry.',
          originalPrompt: content,
        } });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (deadline) clearTimeout(deadline);
      if (activeRequests.current.get(target) === controller) {
        activeRequests.current.delete(target);
        update(target, { type: 'SET_LOADING', payload: false });
      }
      await saveQueue;
      if (pendingSaves.current.get(target) === saveQueue) pendingSaves.current.delete(target);
    }
  }, [update, onConversationSaved]);

  const setSessionId = useCallback((id: string) => {
    sessionId.current = id;
    refresh();
  }, []);

  const setMessages = useCallback((messages: Message[]) => {
    const id = sessionId.current;
    const cached = conversations.current.get(id);
    const merged = new Map(messages.map(message => [message.id, message]));
    cached?.messages.forEach(message => merged.set(message.id, message));
    update(id, { type: 'SET_MESSAGES', payload: [...merged.values()] });
    if (cached?.error) update(id, { type: 'SET_ERROR', payload: cached.error });
    if (cached?.saveError) update(id, { type: 'SET_SAVE_ERROR', payload: cached.saveError });
    if (activeRequests.current.has(id)) update(id, { type: 'SET_LOADING', payload: true });
  }, [update]);

  const forgetConversation = useCallback((id: string) => {
    deleted.current.add(id);
    activeRequests.current.get(id)?.abort();
    activeRequests.current.delete(id);
    conversations.current.delete(id);
    refresh();
  }, []);

  const clearMessages = useCallback(() => {
    cancelRequest();
    setSessionId(resetSession());
  }, [cancelRequest, setSessionId]);

  const state = conversations.current.get(sessionId.current) ?? initialChatState;
  const value: ChatContextValue = {
    ...state, sessionId: sessionId.current, sendMessage, cancelRequest, setSessionId, setMessages, clearMessages, forgetConversation,
    retryMessage: credentials => { if (state.error) void sendMessage(state.error.originalPrompt, credentials); },
    dismissSaveError: () => update(sessionId.current, { type: 'SET_SAVE_ERROR', payload: null }),
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
