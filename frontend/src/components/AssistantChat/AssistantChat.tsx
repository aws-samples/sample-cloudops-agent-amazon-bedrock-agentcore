import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  useAuiState,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';
import type { Message } from '@/types';
import { MarkdownRenderer } from '@/components/MarkdownRenderer/MarkdownRenderer';
import { parseToolParts } from '@/services/streamEvents';
import { DataTable, Chart } from '@/components/tool-ui/results';
import styles from '@/components/MessageDisplay/MessageDisplay.module.css';

function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : 'user',
    content: [{ type: 'text', text: message.content }],
    createdAt: new Date(message.timestamp),
    ...(message.role === 'agent'
      ? {
          status:
            message.status === 'streaming'
              ? { type: 'running' as const }
              : message.status === 'interrupted'
                ? { type: 'incomplete' as const, reason: 'cancelled' as const }
                : { type: 'complete' as const, reason: 'stop' as const },
        }
      : {}),
    metadata: {
      custom: {
        tools: message.partsVersion === 1 ? parseToolParts(message.tools) : [],
        status: message.status,
      },
    },
  };
}

export function AssistantChatProvider({
  messages,
  isLoading,
  onSend,
  onCancel,
  children,
}: {
  messages: Message[];
  isLoading: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: isLoading,
    convertMessage,
    onNew: async (message) => {
      onSend(
        message.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n'),
      );
    },
    onCancel: async () => {
      onCancel?.();
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function ChatMessage() {
  const message = useAuiState((s) => s.message);
  const assistant = message.role === 'assistant';
  const tools = parseToolParts(message.metadata.custom.tools);
  const text = message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  return (
    <MessagePrimitive.Root
      className={assistant ? styles.agentMessageRow : styles.userMessageRow}
      aria-label={assistant ? 'Agent message' : 'Your message'}
    >
      {assistant && (
        <div className={styles.agentAvatar} aria-hidden="true">
          ✦
        </div>
      )}
      <div className={assistant ? styles.agentMessage : styles.userMessage}>
        {assistant ? <MarkdownRenderer content={text} /> : text}
        {tools.map((tool) => (
          <section key={tool.id} aria-label={`Tool ${tool.name}`}>
            <p role="status">
              {tool.name}: {tool.status}
            </p>
            {tool.presentation?.kind === 'resources' ? (
              <DataTable rows={tool.presentation.rows} />
            ) : tool.presentation?.kind === 'costs' ? (
              <Chart
                unit={tool.presentation.unit}
                points={tool.presentation.points}
              />
            ) : (
              tool.status === 'completed' && (
                <p>Structured preview unavailable. See the agent's answer.</p>
              )
            )}
          </section>
        ))}
        {message.metadata.custom.status === 'interrupted' && (
          <p role="status">
            Incomplete response. Receipt stopped or failed; server-side
            execution may continue.
          </p>
        )}
      </div>
      {!assistant && (
        <div className={styles.userAvatar} aria-hidden="true">
          You
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

export function AssistantMessages() {
  return (
    <ThreadPrimitive.Messages
      components={{ UserMessage: ChatMessage, AssistantMessage: ChatMessage }}
    />
  );
}
