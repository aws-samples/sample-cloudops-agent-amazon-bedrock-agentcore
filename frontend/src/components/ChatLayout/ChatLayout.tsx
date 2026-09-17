import { useState, useCallback } from 'react';
import { Sidebar } from '@/components/Sidebar/Sidebar';
import { ChatHeader } from '@/components/ChatHeader/ChatHeader';
import { MessageDisplay } from '@/components/MessageDisplay/MessageDisplay';
import { MessageInput } from '@/components/MessageInput/MessageInput';
import { ErrorMessage } from '@/components/ErrorMessage/ErrorMessage';
import type { Message, ConversationMetadata } from '@/types';
import styles from './ChatLayout.module.css';

interface ChatLayoutProps {
  messages: Message[];
  isLoading: boolean;
  progressMessage: string | null;
  error: { message: string; originalPrompt: string } | null;
  saveError?: string | null;
  onDismissSaveError?: () => void;
  agentName: string;
  userName: string;
  onSendMessage: (text: string) => void;
  onRetry: () => void;
  onClearMessages: () => void;
  onCancelRequest?: () => void;
  onOpenSettings?: () => void;
  onLogout?: () => void;
  // Conversation props for Sidebar
  conversations?: ConversationMetadata[];
  activeConversationId?: string | null;
  isLoadingList?: boolean;
  listError?: string | null;
  onSelectConversation?: (id: string) => void;
  onNewConversation?: () => void;
  onRenameConversation?: (id: string, name: string) => void;
  onDeleteConversation?: (id: string) => void;
  onRetryLoad?: () => void;
}

export function ChatLayout({
  messages,
  isLoading,
  progressMessage,
  error,
  saveError,
  onDismissSaveError,
  agentName,
  userName,
  onSendMessage,
  onRetry,
  onClearMessages,
  onCancelRequest,
  onOpenSettings,
  onLogout,
  conversations,
  activeConversationId,
  isLoadingList,
  listError,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
  onRetryLoad,
}: ChatLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleCancelError = useCallback(() => {
    // Dismiss error without retrying — clear messages starts fresh
    onClearMessages();
  }, [onClearMessages]);

  return (
    <div className={styles.layout}>
      <Sidebar
        isOpen={sidebarOpen}
        onClose={handleCloseSidebar}
        conversations={conversations}
        activeConversationId={activeConversationId}
        isLoadingList={isLoadingList}
        listError={listError}
        onSelectConversation={onSelectConversation}
        onNewConversation={onNewConversation}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
        onRetryLoad={onRetryLoad}
      />
      <main className={styles.main}>
        <ChatHeader
          onNewConversation={onClearMessages}
          onToggleSidebar={handleToggleSidebar}
          onOpenSettings={onOpenSettings}
          onLogout={onLogout}
          agentName={agentName}
          userName={userName}
        />
        <MessageDisplay
          messages={messages}
          isLoading={isLoading}
          progressMessage={progressMessage}
          userName={userName}
        />
        {error && (
          <ErrorMessage
            error={error.message}
            onRetry={onRetry}
            onCancel={handleCancelError}
          />
        )}
        {saveError && (
          <div className={styles.saveNotice} role="status">
            <span className={styles.saveNoticeText}>{saveError}</span>
            {onDismissSaveError && (
              <button
                type="button"
                className={styles.saveNoticeDismiss}
                onClick={onDismissSaveError}
                aria-label="Dismiss save notice"
              >
                ✕
              </button>
            )}
          </div>
        )}
        <MessageInput onSend={onSendMessage} disabled={isLoading} onCancel={onCancelRequest} />
      </main>
    </div>
  );
}
