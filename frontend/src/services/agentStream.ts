import { z } from 'zod';
import { toolOutputSchema } from './toolOutput';

const eventSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  type: z.enum(['run-start', 'run-stage', 'text-delta', 'tool-start', 'tool-complete', 'tool-error', 'run-complete', 'run-error']),
  stage: z.enum(['discovering-tools', 'waiting-model', 'model-retry']).optional(),
  text: z.string().max(64_000).optional(),
  toolCallId: z.string().min(1).max(128).optional(),
  toolName: z.string().min(1).max(200).optional(),
  presentation: z.unknown().optional(),
  output: toolOutputSchema.optional(),
  code: z.enum(['access-denied', 'capability-unavailable', 'tool-unavailable', 'agent-error', 'incomplete']).optional(),
});

export type AgentEvent = z.infer<typeof eventSchema>;

export class AgentStreamError extends Error {
  constructor(message: string, public code?: AgentEvent['code']) {
    super(message);
    this.name = 'AgentStreamError';
  }
}

/** Decode SSE frames, not HTTP chunks. The caller owns the conversation identity. */
export async function readAgentStream(
  response: Response,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) throw new Error('The response stream is missing. Please retry.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let runId: string | undefined;
  let messageId: string | undefined;
  let sequence = -1;
  let complete = false;
  let totalBytes = 0;
  const tools = new Map<string, { name: string; complete: boolean }>();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });

  const frame = (value: string) => {
    const data = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (value.length > 64_000) throw new Error('The response event is too large. Please retry.');
    let event: AgentEvent;
    try { event = eventSchema.parse(JSON.parse(data)); }
    catch { throw new Error('The agent returned an invalid response event. Please retry.'); }
    if (runId && (event.runId !== runId || event.messageId !== messageId)) return;
    if (event.sequence <= sequence) return;
    if (!runId && event.type !== 'run-start') throw new Error('The response stream did not start correctly. Please retry.');
    if (event.sequence !== sequence + 1) throw new Error('Part of the response is missing. Please retry.');
    runId = event.runId;
    messageId = event.messageId;
    sequence = event.sequence;
    if (event.type === 'text-delta') {
      if (event.text === undefined) throw new Error('Invalid response text. Please retry.');
      text += event.text;
      if (text.length > 100_000) throw new Error('The response is too large. Please ask a narrower question.');
    }
    if (event.type.startsWith('tool-')) {
      if (!event.toolCallId || !event.toolName) throw new Error('Invalid tool event. Please retry.');
      const tool = tools.get(event.toolCallId);
      if (event.type === 'tool-start') {
        if (tool || tools.size >= 30) throw new Error('Invalid or excessive tool activity. Please retry with a narrower question.');
        tools.set(event.toolCallId, { name: event.toolName, complete: false });
      } else {
        if (!tool || tool.complete || tool.name !== event.toolName) throw new Error('Unexpected tool result. Please retry.');
        tool.complete = true;
      }
    }
    if (event.type === 'run-stage' && !event.stage) throw new Error('Invalid investigation stage. Please retry.');
    if (event.type === 'run-complete' && [...tools.values()].some(tool => !tool.complete)) {
      throw new Error('The investigation ended with unfinished tools. Please retry.');
    }
    if (event.type === 'run-start' && sequence !== 0) throw new Error('The agent restarted unexpectedly. Please retry.');
    onEvent(event);
    if (event.type === 'run-error') throw new AgentStreamError(event.code === 'access-denied'
      ? 'This capability is not available for your role.'
      : 'The investigation could not finish. Please retry.', event.code);
    complete = event.type === 'run-complete';
  };

  try {
    while (!complete) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (value) totalBytes += value.byteLength;
      if (totalBytes > 1_000_000) throw new Error('The response is too large. Please ask a narrower question.');
      buffer += decoder.decode(value, { stream: !done });
      let match: RegExpMatchArray | null;
      while (!complete && (match = buffer.match(/\r?\n\r?\n/))) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index! + match[0].length);
      }
      if (buffer.length > 128_000) throw new Error('The response event is too large. Please retry.');
      if (done) break;
    }
    if (!complete) throw new Error('The connection ended before the investigation finished. Please retry.');
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
