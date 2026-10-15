// Workspace composition copied from assistant-ui/templates/default/app/assistant.tsx.
import { ChevronRight, Info, X } from 'lucide-react';
import { ThreadListSidebar } from '@/components/assistant-ui/threadlist-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { AgentThread } from './AgentThread';
import type { Message, ConversationMetadata } from '@/types';

interface ChatLayoutProps {
  sessionId: string;
  canUseOperations?: boolean;
  messages: Message[];
  isLoading: boolean;
  progressMessage?: string | null;
  isPreparing?: boolean;
  conversationError?: string | null;
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

export function ChatLayout(props: ChatLayoutProps) {
  const local = import.meta.env.DEV && import.meta.env.VITE_LOCAL_API === '1';
  const title = props.conversations?.find(thread => thread.conversationId === props.activeConversationId)?.conversationName;
  return (
    <SidebarProvider className="min-h-0">
      <div className="flex h-dvh w-full min-w-0">
        <ThreadListSidebar
          agentName={props.agentName} userName={props.userName} conversations={props.conversations ?? []}
          activeConversationId={props.activeConversationId} isLoading={props.isLoadingList} error={props.listError}
          onSelect={props.onSelectConversation} onNew={props.onNewConversation ?? props.onClearMessages}
          onRename={props.onRenameConversation} onDelete={props.onDeleteConversation} onRetry={props.onRetryLoad}
          onSettings={props.onOpenSettings} onLogout={props.onLogout}
        />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
            <SidebarTrigger aria-label="Toggle sidebar" className="text-muted-foreground" />
            <div className="bg-border h-4 w-px" />
            <span className="text-muted-foreground hidden text-xs sm:inline">Workspace</span>
            <ChevronRight className="text-muted-foreground hidden size-3 sm:block" />
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title ?? 'New investigation'}</h1>
            <span className="text-muted-foreground shrink-0 rounded-md border px-2 py-1 text-[11px]">{local ? 'Local dev · live AWS' : 'AWS workspace'}</span>
          </header>
          <div className="min-h-0 flex-1">
            <AgentThread key={props.sessionId} canUseOperations={props.canUseOperations} messages={props.messages} isLoading={props.isLoading} progressMessage={props.progressMessage} isPreparing={props.isPreparing} onSend={props.onSendMessage} onCancel={props.onCancelRequest} agentName={props.agentName}>
              {props.conversationError && <div role="alert" className="text-destructive rounded-xl border px-3 py-2 text-xs">{props.conversationError}</div>}
              {props.error && <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-xs"><p className="text-destructive">{props.error.message}</p><div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={props.onRetry}>Retry</Button><Button size="sm" variant="ghost" onClick={props.onClearMessages}>Start a new conversation</Button></div></div>}
              {props.saveError && <div role="status" className="text-muted-foreground flex items-start gap-2 rounded-xl border bg-muted/40 p-3 text-xs"><Info className="mt-0.5 size-4 shrink-0" /><span className="flex-1">{props.saveError}</span><Button variant="ghost" size="icon-sm" className="-m-1 size-7" onClick={props.onDismissSaveError} aria-label="Dismiss save notice"><X /></Button></div>}
            </AgentThread>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
