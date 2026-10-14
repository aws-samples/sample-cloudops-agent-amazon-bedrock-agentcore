import type { Message } from '@/types';
import { TypingIndicator } from '@/components/TypingIndicator/TypingIndicator';
import { ScrollToBottom } from '@/components/MessageDisplay/ScrollToBottom';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import styles from './MessageDisplay.module.css';
import { AssistantMessages } from '@/components/AssistantChat/AssistantChat';

interface MessageDisplayProps {
  messages: Message[];
  isLoading: boolean;
  progressMessage: string | null;
  userName?: string;
}

export function MessageDisplay({
  messages,
  isLoading,
  progressMessage,
}: MessageDisplayProps) {
  const { containerRef, isUserScrolledUp, handleScroll, scrollToBottom } =
    useAutoScroll(messages, isLoading);

  return (
    <div
      className={styles.container}
      ref={containerRef}
      onScroll={handleScroll}
      role="log"
      aria-label="Chat messages"
    >
      <div className={styles.messageList}>
        <AssistantMessages />
        {isLoading && (
          <TypingIndicator progressMessage={progressMessage} />
        )}
      </div>

      <ScrollToBottom
        onClick={scrollToBottom}
        visible={isUserScrolledUp}
      />
    </div>
  );
}
