import type { ReactNode } from 'react';
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import type { Message } from '@/types';
import { Thread } from '@/components/assistant-ui/thread';

function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : 'user',
    content: message.partsVersion === 1 && message.parts?.length
      ? message.parts.map(part => part.type === 'text' ? part : ({
        type: 'tool-call' as const, toolCallId: part.toolCallId, toolName: part.toolName,
        args: {}, argsText: '{}',
        result: part.status === 'running' ? undefined : { status: part.status, presentation: part.presentation, output: part.output },
        isError: part.status === 'failed',
      }))
      : message.content,
    createdAt: new Date(message.timestamp),
    metadata: { custom: { restricted: message.status === 'restricted' } },
    ...(message.role === 'agent' && {
      status: message.status === 'streaming'
        ? { type: 'running' as const }
        : message.status === 'interrupted' || message.status === 'error'
          ? { type: 'incomplete' as const, reason: 'error' as const }
          : { type: 'complete' as const, reason: 'stop' as const },
    }),
  };
}

interface AgentThreadProps {
  messages: Message[];
  isLoading: boolean;
  progressMessage?: string | null;
  isPreparing?: boolean;
  agentName: string;
  canUseOperations?: boolean;
  onSend: (text: string) => void;
  onCancel?: () => void;
  children?: ReactNode;
}

/** Only the adapter is CloudOps-specific; the presentation starts from upstream. */
export function AgentThread({ messages, isLoading, progressMessage, isPreparing, agentName, canUseOperations, onSend, onCancel, children }: AgentThreadProps) {
  const runtime = useExternalStoreRuntime({
    messages, isRunning: isLoading, isSendDisabled: isLoading || isPreparing, convertMessage,
    onNew: async message => {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
      if (text) onSend(text);
    },
    onCancel: async () => { onCancel?.(); },
  });
  return <AssistantRuntimeProvider runtime={runtime}><Thread agentName={agentName} progressMessage={progressMessage} canUseOperations={canUseOperations} isPreparing={isPreparing}>{children}</Thread></AssistantRuntimeProvider>;
}
