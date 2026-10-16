// Adapted from the official assistant-ui starter. See UPSTREAM.md.
// THESIS: A focused investigation, not a dashboard or a reskinned legacy chat.
// OWN-WORLD: Upstream neutral surfaces, compact controls, centered 44rem thread.
// STORY: Ask, watch real tool activity, inspect evidence, continue the conversation.
// FIRST VIEWPORT: Quiet sidebar; centered welcome, composer, and useful suggestions.
// FORM: User-pinned assistant-ui default/minimal starter; no competing visual concept.
import type { ReactNode } from 'react';
import {
  ActionBarPrimitive, AuiIf, ComposerPrimitive, MessagePrimitive,
  ThreadPrimitive, useAui, useAuiState, type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, Check, ChevronDown, Cloud, Copy, Database, DollarSign, LoaderCircle, LockKeyhole, ShieldCheck, Square, Wrench, XCircle } from 'lucide-react';
import { TooltipIconButton } from './tooltip-icon-button';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/MarkdownRenderer/MarkdownRenderer';
import { ToolResult } from '@/components/tool-ui/ToolResult';
import { RawToolOutput } from '@/components/tool-ui/RawToolOutput';
import { AccessRestricted } from './access-restricted';
import { cn } from '@/lib/utils';

interface ThreadProps {
  isPreparing?: boolean;
  agentName: string;
  progressMessage?: string | null;
  canUseOperations?: boolean;
  children?: ReactNode;
}

export function Thread({ isPreparing, agentName, progressMessage, canUseOperations = false, children }: ThreadProps) {
  const isEmpty = useAuiState(s => s.thread.messages.length === 0);
  const isRunning = useAuiState(s => s.thread.isRunning);
  return (
    <ThreadPrimitive.Root className="aui-root aui-thread-root bg-background flex h-full min-h-0 flex-col" style={{ ['--thread-max-width' as string]: '44rem' }}>
      <ThreadPrimitive.Viewport className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scroll-smooth" role="log" aria-label="Chat messages">
        <div className={cn('mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-5 pt-8 md:px-6', isEmpty && 'justify-center pb-16')}>
          {isEmpty && (
            <div className="aui-thread-welcome-root mb-7 px-1">
              <div className="mb-5 flex size-11 items-center justify-center rounded-2xl border bg-background"><Cloud className="size-5" strokeWidth={1.5} /></div>
              <h2 className="text-2xl font-medium tracking-tight md:text-[28px]">What would you like to investigate?</h2>
              <p className="text-muted-foreground mt-2 text-sm">{canUseOperations ? 'Your AWS environment. One conversation.' : 'Billing and pricing are available for your role.'}</p>
            </div>
          )}
          <div className="mb-10 flex flex-col gap-y-8 empty:hidden">
            <ThreadPrimitive.Messages>{({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage agentName={agentName} />}</ThreadPrimitive.Messages>
          </div>
          {!isEmpty && isRunning && <p className="text-muted-foreground mb-4 flex items-center gap-2 px-2 text-xs" role="status"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" /> {progressMessage ?? 'Investigating your request'}</p>}
          <ThreadPrimitive.ViewportFooter className={cn('aui-thread-viewport-footer bg-background relative flex flex-col gap-3 pb-4 md:pb-5', !isEmpty && 'sticky bottom-0 mt-auto pt-3')}>
            {!isEmpty && <ThreadPrimitive.ScrollToBottom asChild><TooltipIconButton tooltip="Jump to latest" variant="outline" className="absolute -top-10 z-10 self-center rounded-full border bg-background disabled:invisible"><ArrowDown /></TooltipIconButton></ThreadPrimitive.ScrollToBottom>}
            {children}
            <Composer isPreparing={isPreparing} />
            {isEmpty && <ThreadSuggestions canUseOperations={canUseOperations} />}
            <p className="text-muted-foreground px-2 text-center text-[11px] leading-5">Review findings before acting. Available tools depend on your role.</p>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function Composer({ isPreparing }: { isPreparing?: boolean }) {
  const isRunning = useAuiState(s => s.thread.isRunning);
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div className="aui-composer-shell border-foreground/15 focus-within:border-foreground/40 flex flex-col gap-3 rounded-2xl border bg-muted/30 p-3 transition-colors">
        <ComposerPrimitive.Input
          placeholder="Ask about your AWS environment…"
          className="aui-composer-input placeholder:text-muted-foreground min-h-14 w-full resize-none bg-transparent px-1 py-1 text-[15px] leading-6 outline-none focus-visible:outline-none disabled:cursor-wait"
          rows={2} maxRows={7} maxLength={2000} autoFocus
          disabled={isRunning || isPreparing} addAttachmentOnPaste={false} aria-label="Message input"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs"><ShieldCheck className="size-3.5" />Bedrock AgentCore</span>
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild><Button size="icon" className="size-9 rounded-full" aria-label="Stop receiving response"><Square className="size-3.5 fill-current" /></Button></ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild><Button size="icon" className="size-9 rounded-full" aria-label="Send message"><ArrowUp className="size-4" /></Button></ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

const billingSuggestions = [
  { title: 'Investigate costs', description: 'Understand spending and what changed', prompt: 'Help me investigate my AWS costs for the last 7 days.', icon: DollarSign },
  { title: 'Compare AWS pricing', description: 'Look up service prices and compare options', prompt: 'Help me compare AWS service pricing. Ask which services and regions I want to compare.', icon: DollarSign },
];
const operationalSuggestions = [
  { title: 'Explore resource inventory', description: 'Find resources and their support lifecycle', prompt: 'List my RDS instances in us-east-1 and summarize their engine versions and support dates.', icon: Database },
  { title: 'Check operational health', description: 'Review alarms, metrics, and recent activity', prompt: 'Check the active CloudWatch alarms in us-east-1 and summarize what needs attention.', icon: ShieldCheck },
];

const restrictedSuggestion = {
  title: 'Check CloudWatch alarms (admin-only)', description: 'See how restricted access is handled',
  prompt: 'Check the active CloudWatch alarms in us-east-1 and summarize which resources need attention.', icon: LockKeyhole,
};

function ThreadSuggestions({ canUseOperations }: { canUseOperations: boolean }) {
  const aui = useAui();
  const suggestions = canUseOperations
    ? [billingSuggestions[0], ...operationalSuggestions] : [...billingSuggestions, restrictedSuggestion];
  return (
    <div className="aui-thread-welcome-suggestions mt-1 flex flex-col gap-0.5">
      {suggestions.map(({ title, description, prompt, icon: Icon }) => (
        <button key={title} type="button" aria-label={title} onClick={() => { aui.composer().setText(prompt); }} className="group hover:bg-muted flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors">
          <Icon className="text-muted-foreground size-4 shrink-0" strokeWidth={1.5} />
          <span className="text-sm"><span className="font-medium">{title}</span><span className="text-muted-foreground ml-2 hidden sm:inline">{description}</span></span>
        </button>
      ))}
    </div>
  );
}

function MarkdownPart({ text }: { text: string }) { return <MarkdownRenderer content={text} />; }

function ToolCall({ toolName, result }: ToolCallMessagePartProps) {
  const value = result as { status?: string; presentation?: unknown; output?: unknown } | undefined;
  const state = value?.status ?? 'running';
  if (state === 'blocked') return <AccessRestricted output={value?.output} unavailable={toolName === 'report_access_restricted'} />;
  if (state === 'unavailable') return (
    <section aria-label="Capability unavailable" className="my-3 rounded-xl border bg-muted/40 p-4">
      <h3 className="text-sm font-semibold">Capability unavailable</h3>
      <p className="text-muted-foreground mt-1 text-sm">This capability is not available in your current workspace. Ask an administrator about access.</p>
      <RawToolOutput value={value?.output} />
    </section>
  );
  const labels: Record<string, string> = { running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };
  const Icon = state === 'running' ? LoaderCircle : state === 'failed' ? XCircle : state === 'completed' ? Check : Square;
  const title = toolName.split('___').pop()?.replace(/[_-]/g, ' ') ?? toolName;
  return (
    <section aria-label={`Tool: ${toolName}`} className="my-3 min-w-0">
      <details open={Boolean(value?.presentation) || state === 'failed'} className="group/tool overflow-hidden rounded-xl border bg-background">
        <summary className="hover:bg-muted/50 flex min-h-11 list-none items-center gap-2.5 px-3 py-2 text-xs transition-colors [&::-webkit-details-marker]:hidden">
          <Wrench className="text-muted-foreground size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium capitalize">{title}</span>
          <span role="status" className={cn('text-muted-foreground flex items-center gap-1.5', state === 'failed' && 'text-destructive')}><Icon className={cn('size-3.5', state === 'running' && 'animate-spin motion-reduce:animate-none')} />{labels[state] ?? 'Interrupted'}</span>
          <ChevronDown className="text-muted-foreground size-3.5 transition-transform group-open/tool:rotate-180" />
        </summary>
        <div className="border-t px-3 pb-3 pt-2">
          {state === 'completed' && value?.presentation !== undefined && <ToolResult value={value.presentation} />}
          {state === 'completed' && !value?.presentation && !value?.output && <p className="text-muted-foreground text-xs">This saved response predates raw-output capture. Run the tool again to inspect its JSON.</p>}
          {value?.output !== undefined && <RawToolOutput value={value.output} />}
          {state === 'failed' && <p className="text-destructive text-xs">The tool did not return an available result.</p>}
          {state === 'running' && <p className="text-muted-foreground text-xs">Waiting for this tool to return.</p>}
          {state === 'interrupted' && <p className="text-muted-foreground text-xs">Receipt stopped. Remote execution may still be running.</p>}
        </div>
      </details>
    </section>
  );
}

function AssistantMessage({ agentName }: { agentName: string }) {
  return (
    <MessagePrimitive.Root className="aui-assistant-message-root relative min-w-0 px-1" role="article" aria-label="Agent message">
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium"><Cloud className="size-4" strokeWidth={1.5} />{agentName}</div>
      <div className="text-foreground leading-relaxed wrap-break-word">
        <MessagePrimitive.Parts components={{ Text: MarkdownPart, tools: { Fallback: ToolCall } }} />
        <AuiIf condition={s => s.message.metadata.custom.restricted === true && !s.message.parts.some(part => part.type === 'tool-call' && (part.result as { status?: string } | undefined)?.status === 'blocked')}><AccessRestricted /></AuiIf>
        <AuiIf condition={s => s.message.status?.type === 'incomplete'}><p className="text-destructive mt-3 text-xs">Incomplete response. Remote execution may still be running.</p></AuiIf>
      </div>
      <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="text-muted-foreground mt-2 -ml-1 flex gap-1">
        <ActionBarPrimitive.Copy asChild><TooltipIconButton tooltip="Copy answer"><AuiIf condition={s => s.message.isCopied}><Check /></AuiIf><AuiIf condition={s => !s.message.isCopied}><Copy /></AuiIf></TooltipIconButton></ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-user-message-root flex justify-end px-1" role="article" aria-label="Your message">
      <div className="aui-user-message-content max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap wrap-break-word"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}
