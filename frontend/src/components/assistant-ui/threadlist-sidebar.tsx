// Copied from assistant-ui ThreadListSidebar; bound to CloudOps history. See UPSTREAM.md.
import { useState, useRef, useEffect } from 'react';
import { DropdownMenu } from 'radix-ui';
import { Check, Cloud, LogOut, MoreHorizontal, Pencil, Search, Settings2, SquarePen, Trash2, UserRound, X } from 'lucide-react';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail, useSidebar } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import type { ConversationMetadata } from '@/types';
import { cn } from '@/lib/utils';

interface Props {
  agentName: string;
  userName: string;
  conversations: ConversationMetadata[];
  activeConversationId?: string | null;
  isLoading?: boolean;
  error?: string | null;
  onSelect?: (id: string) => void;
  onNew?: () => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  onRetry?: () => void;
  onSettings?: () => void;
  onLogout?: () => void;
}

export function ThreadListSidebar(props: Props) {
  const [search, setSearch] = useState('');
  const { setOpenMobile } = useSidebar();
  const threads = [...props.conversations]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .filter(thread => thread.conversationName.toLowerCase().includes(search.toLowerCase()));
  const select = (id: string) => { props.onSelect?.(id); setOpenMobile(false); };
  return (
    <Sidebar className="border-r" role="navigation" aria-label="Sidebar navigation">
      <SidebarHeader className="aui-sidebar-header gap-5 px-4 pb-3 pt-5">
        <div className="flex items-center gap-2.5 px-1"><span className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-xl"><Cloud className="size-4" strokeWidth={1.7} /></span><span className="text-sm font-semibold tracking-tight">{props.agentName}</span></div>
        <Button variant="outline" onClick={() => { props.onNew?.(); setOpenMobile(false); }} aria-label="New Conversation" className="h-10 w-full justify-start gap-2.5 border bg-background font-normal"><SquarePen className="size-4" />New conversation</Button>
        <label className="text-muted-foreground flex h-9 items-center gap-2 rounded-lg border border-transparent px-2 focus-within:border-input focus-within:bg-background"><Search className="size-4 shrink-0" /><input type="search" aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={event => setSearch(event.target.value)} className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none focus-visible:outline-none" /></label>
      </SidebarHeader>
      <SidebarContent className="aui-sidebar-content gap-1 px-3">
        <h2 className="text-muted-foreground px-2 pb-2 pt-3 text-xs font-medium">Conversations</h2>
        {props.isLoading && <div role="status" aria-label="Loading conversations" className="space-y-3 px-2 py-2">{[1, 2, 3].map(key => <div key={key} className="h-4 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div>}
        {props.error && <div role="alert" className="px-2 py-3 text-xs"><p className="text-destructive">{props.error}</p><Button variant="ghost" size="sm" onClick={props.onRetry} className="mt-2">Retry</Button></div>}
        {!props.isLoading && !props.error && threads.length > 0 && <div role="list" aria-label="Conversation list" className="space-y-0.5">{threads.map(thread => <ThreadItem key={thread.conversationId} thread={thread} active={thread.conversationId === props.activeConversationId} onSelect={select} onRename={props.onRename} onDelete={props.onDelete} />)}</div>}
        {!props.isLoading && !props.error && !threads.length && <p className="text-muted-foreground px-2 py-3 text-xs leading-5">{search ? 'No matching conversations.' : 'Your investigations will appear here.'}</p>}
      </SidebarContent>
      <SidebarRail />
      <SidebarFooter className="aui-sidebar-footer gap-2 border-t p-3">
        {import.meta.env.DEV && import.meta.env.VITE_LOCAL_API === '1' && <p className="text-muted-foreground px-2 py-1 text-[11px] leading-4">Local history resets when the backend restarts.</p>}
        <div className="flex items-center gap-2 rounded-lg px-2 py-2"><span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"><UserRound className="size-4" /></span><span className="min-w-0 flex-1 truncate text-sm">{props.userName}</span><Button variant="ghost" size="icon-sm" aria-label="Open settings" title="Settings" onClick={props.onSettings}><Settings2 /></Button><Button variant="ghost" size="icon-sm" aria-label="Sign out" title="Sign out" onClick={props.onLogout}><LogOut /></Button></div>
      </SidebarFooter>
    </Sidebar>
  );
}

function ThreadItem({ thread, active, onSelect, onRename, onDelete }: {
  thread: ConversationMetadata; active: boolean; onSelect: (id: string) => void;
  onRename?: (id: string, name: string) => void; onDelete?: (id: string) => void;
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
  const [name, setName] = useState(thread.conversationName);
  const input = useRef<HTMLInputElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const editingFromMenu = useRef(false);
  useEffect(() => { if (mode === 'rename') { input.current?.focus(); input.current?.select(); } }, [mode]);
  const save = () => {
    if (name.trim() && name.trim() !== thread.conversationName) onRename?.(thread.conversationId, name.trim());
    setMode('view');
  };
  if (mode === 'rename') return (
    <div role="listitem" className="flex items-center gap-1 rounded-lg border bg-background p-1">
      <input ref={input} aria-label="Rename conversation" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setMode('view'); }} className="min-w-0 flex-1 rounded px-2 py-1.5 text-sm" />
      <Button variant="ghost" size="icon-sm" aria-label="Save conversation name" onClick={save}><Check /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="Cancel rename" onClick={() => setMode('view')}><X /></Button>
    </div>
  );
  if (mode === 'delete') return <div role="listitem" className="rounded-lg border bg-background p-3"><p className="mb-2 text-xs">Delete this conversation?</p><div className="flex gap-2"><Button size="sm" variant="destructive" aria-label="Confirm delete" onClick={() => { onDelete?.(thread.conversationId); setMode('view'); }}>Delete</Button><Button size="sm" variant="ghost" aria-label="Cancel delete" onClick={() => setMode('view')}>Cancel</Button></div></div>;
  return (
    <div role="listitem" className={cn('group/thread relative flex items-center rounded-lg transition-colors', active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/70')}>
      <button type="button" aria-label={`Open conversation: ${thread.conversationName}`} aria-current={active ? 'true' : undefined} onClick={() => onSelect(thread.conversationId)} className="min-w-0 flex-1 truncate rounded-lg py-2.5 pl-2.5 pr-9 text-left text-[13px]">{thread.conversationName}</button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon-sm" ref={menuTrigger} aria-label={`Actions for ${thread.conversationName}`} className="absolute right-1 size-7 opacity-70 group-hover/thread:opacity-100 focus-visible:opacity-100"><MoreHorizontal className="size-3.5" /></Button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content align="start" side="right" sideOffset={5} onCloseAutoFocus={event => { event.preventDefault(); if (editingFromMenu.current) input.current?.focus(); else menuTrigger.current?.focus(); editingFromMenu.current = false; }} className="bg-popover text-popover-foreground z-50 min-w-36 rounded-xl border p-1 shadow-md">
          <DropdownMenu.Item onSelect={() => { editingFromMenu.current = true; setName(thread.conversationName); setMode('rename'); }} className="focus:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none"><Pencil className="size-3.5" />Rename</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setMode('delete')} className="text-destructive focus:bg-accent flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none"><Trash2 className="size-3.5" />Delete</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
