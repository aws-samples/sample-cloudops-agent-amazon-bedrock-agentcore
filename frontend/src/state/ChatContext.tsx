import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import { initialChatState } from '@/state/chatReducer';
import { invokeAgent } from '@/services/agentCore';
import { getOrCreateSession, resetSession } from '@/services/session';
import { getAppConfig } from '@/services/config';
import { Message, AgentCredentials, ChatState } from '@/types';
import { appendMessages } from '@/services/conversationService';
import { parseToolParts, type StreamEvent } from '@/services/streamEvents';
import { fetchAuthSession } from 'aws-amplify/auth';
import { v4 as uuidv4 } from 'uuid';

interface ChatContextValue extends ChatState {
  sessionId: string;
  sendMessage: (
    content: string,
    credentials: AgentCredentials,
  ) => Promise<void>;
  retryMessage: (credentials: AgentCredentials) => void;
  clearMessages: () => void;
  cancelRequest: () => void;
  discardConversation: (id: string) => void;
  setMessages: (messages: Message[]) => void;
  setSessionId: (id: string) => void;
  dismissSaveError: () => void;
}
const ChatContext = createContext<ChatContextValue | undefined>(undefined);
const REQUEST_TIMEOUT_MS = 120_000;

async function token(runtime = false): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return (
      (runtime ? session.tokens?.accessToken?.toString() : undefined) ||
      session.tokens?.idToken?.toString() ||
      null
    );
  } catch {
    return null;
  }
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  // One authoritative state per conversation, also used by the external-store adapter.
  const store = useRef(new Map<string, ChatState>());
  const active = useRef(new Map<string, AbortController>());
  const deleted = useRef(new Set<string>());
  const sessionId = useRef(getOrCreateSession());
  const [, render] = useState(0);
  const mounted = useRef(true);
  const update = useCallback(
    (id: string, change: (state: ChatState) => ChatState) => {
      if (!mounted.current || deleted.current.has(id)) return;
      store.current.set(id, change(store.current.get(id) || initialChatState));
      if (sessionId.current === id) render((n) => n + 1);
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current.forEach((controller) => controller.abort());
      active.current.clear();
    };
  }, []);

  const stop = useCallback(
    (id: string) => {
      active.current.get(id)?.abort();
      active.current.delete(id);
      update(id, (s) => ({
        ...s,
        isLoading: false,
        messages: s.messages.map((m) =>
          m.status === 'streaming'
            ? {
                ...m,
                status: 'interrupted',
                tools: m.tools?.map((t) =>
                  t.status === 'running' ? { ...t, status: 'interrupted' } : t,
                ),
              }
            : m,
        ),
      }));
    },
    [update],
  );
  const cancelRequest = useCallback(() => stop(sessionId.current), [stop]);
  const discardConversation = useCallback(
    (id: string) => {
      deleted.current.add(id);
      stop(id);
      store.current.delete(id);
    },
    [stop],
  );

  const sendMessage = useCallback(
    async (content: string, credentials: AgentCredentials) => {
      const id = sessionId.current;
      if (!content.trim() || content.length > 2000 || deleted.current.has(id))
        return;
      if (active.current.has(id)) return;
      // Reserve before awaiting auth: repeated clicks cannot start duplicate runs.
      const controller = new AbortController();
      active.current.set(id, controller);
      const current = () =>
        mounted.current &&
        !deleted.current.has(id) &&
        active.current.get(id) === controller &&
        !controller.signal.aborted;
      const runId = uuidv4(),
        messageId = uuidv4();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let userSave: Promise<unknown> = Promise.resolve();
      const notice = (message: string) => {
        if (current()) update(id, (s) => ({ ...s, saveError: message }));
      };
      const ensureAssistant = (s: ChatState): Message[] =>
        s.messages.some((m) => m.id === messageId)
          ? s.messages
          : [
              ...s.messages,
              {
                id: messageId,
                role: 'agent',
                content: '',
                timestamp: Date.now(),
                status: 'streaming',
                partsVersion: 1,
                tools: [],
              },
            ];
      try {
        const runtimeToken = await token(true);
        if (!current()) return;
        if (!runtimeToken)
          throw new Error(
            'You must be signed in to send a message. Please sign in and try again.',
          );
        const userMessage: Message = {
          id: uuidv4(),
          role: 'user',
          content,
          timestamp: Date.now(),
          status: 'sent',
        };
        update(id, (s) => ({
          ...s,
          messages: [...s.messages, userMessage],
          isLoading: true,
          error: null,
          saveError: null,
        }));
        timeout = setTimeout(() => stop(id), REQUEST_TIMEOUT_MS);
        const historyToken = await token();
        if (!current()) return;
        if (historyToken) {
          userSave = appendMessages(historyToken, id, [userMessage]).catch(() =>
            notice(
              'Your message was sent, but saving it to conversation history failed. It may not appear after reloading.',
            ),
          );
        } else
          notice(
            'Conversation history could not be saved. Please sign in again.',
          );

        const onEvent = (event: StreamEvent) => {
          if (!current()) return;
          update(id, (s) => ({
            ...s,
            messages: ensureAssistant(s).map((m) => {
              if (m.id !== messageId) return m;
              if (event.type === 'text-delta')
                return { ...m, content: m.content + event.text };
              if (
                event.type === 'tool-start' &&
                !m.tools?.some((t) => t.id === event.toolCallId)
              ) {
                if ((m.tools?.length || 0) >= 50)
                  throw new Error('Too many tool events. Please retry.');
                return {
                  ...m,
                  tools: [
                    ...(m.tools || []),
                    {
                      id: event.toolCallId!,
                      name: event.name!,
                      status: 'running',
                    },
                  ],
                };
              }
              if (
                event.type === 'tool-complete' ||
                event.type === 'tool-failure'
              ) {
                const tools = m.tools?.map((t) =>
                  t.id === event.toolCallId
                    ? {
                        ...t,
                        status:
                          event.type === 'tool-complete'
                            ? ('completed' as const)
                            : ('failed' as const),
                        presentation: event.presentation,
                      }
                    : t,
                );
                if (
                  new TextEncoder().encode(JSON.stringify(tools)).length >
                  64_000
                )
                  throw new Error(
                    'Structured results are too large. Please retry.',
                  );
                return { ...m, tools };
              }
              return m;
            }),
          }));
        };
        const result = await invokeAgent(
          content,
          id,
          getAppConfig(),
          credentials,
          runtimeToken,
          controller.signal,
          { runId, messageId, onEvent },
        );
        if (!current()) return;
        update(id, (s) => ({
          ...s,
          progressMessage: 'Saving conversation history…',
          messages: ensureAssistant(s).map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  content: result,
                  status: 'delivered',
                  tools: m.tools?.map((t) =>
                    t.status === 'running'
                      ? { ...t, status: 'interrupted' }
                      : t,
                  ),
                }
              : m,
          ),
        }));
        const final = store.current
          .get(id)
          ?.messages.find((m) => m.id === messageId);
        // Serialize user/final writes: history appends via read/modify/write.
        await userSave;
        if (!current()) return;
        const saveToken = await token();
        if (!current()) return;
        if (saveToken && final) {
          await appendMessages(saveToken, id, [final]).catch(() =>
            notice(
              'The response was received, but saving it to conversation history failed. It may not appear after reloading.',
            ),
          );
        } else
          notice(
            'The response was received, but conversation history could not be saved. Please sign in again.',
          );
      } catch (error) {
        if (!current()) return;
        update(id, (s) => ({
          ...s,
          isLoading: false,
          messages: s.messages.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  status: 'interrupted',
                  tools: m.tools?.map((t) =>
                    t.status === 'running'
                      ? { ...t, status: 'interrupted' }
                      : t,
                  ),
                }
              : m,
          ),
          error: {
            message:
              error instanceof Error
                ? error.message
                : 'Something went wrong. Please retry.',
            originalPrompt: content,
          },
        }));
      } finally {
        clearTimeout(timeout);
        if (active.current.get(id) === controller) {
          active.current.delete(id);
          update(id, (s) => ({
            ...s,
            isLoading: false,
            progressMessage: null,
          }));
        }
      }
    },
    [update, stop],
  );

  const state = store.current.get(sessionId.current) || initialChatState;
  const retryMessage = useCallback(
    (credentials: AgentCredentials) => {
      const prompt = store.current.get(sessionId.current)?.error
        ?.originalPrompt;
      if (prompt) void sendMessage(prompt, credentials);
    },
    [sendMessage],
  );
  const setSessionId = useCallback((id: string) => {
    sessionId.current = id;
    render((n) => n + 1);
  }, []);
  const setMessages = useCallback(
    (messages: Message[]) =>
      update(sessionId.current, (s) => {
        if (s.isLoading) return s; // Do not overwrite an active run when switching back.
        return {
          ...initialChatState,
          messages: messages.map((m) => ({
            ...m,
            tools: m.partsVersion === 1 ? parseToolParts(m.tools) : undefined,
          })),
        };
      }),
    [update],
  );
  const clearMessages = useCallback(() => {
    cancelRequest();
    setSessionId(resetSession());
  }, [cancelRequest, setSessionId]);
  const dismissSaveError = useCallback(
    () => update(sessionId.current, (s) => ({ ...s, saveError: null })),
    [update],
  );
  return (
    <ChatContext.Provider
      value={{
        ...state,
        sessionId: sessionId.current,
        sendMessage,
        retryMessage,
        clearMessages,
        cancelRequest,
        discardConversation,
        setMessages,
        setSessionId,
        dismissSaveError,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context)
    throw new Error('useChatContext must be used within a ChatProvider');
  return context;
}
