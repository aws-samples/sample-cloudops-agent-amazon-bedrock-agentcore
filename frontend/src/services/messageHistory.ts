import { z } from 'zod';
import type { Message, MessagePart } from '@/types';
import { parsePresentation } from '@/components/tool-ui/schema';
import { parseToolOutput } from './toolOutput';

const identifier = z.string().min(1).max(200);
const partSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(100_000) }),
  z.object({
    type: z.literal('tool'), toolCallId: identifier, toolName: identifier,
    status: z.enum(['running', 'completed', 'failed', 'interrupted', 'blocked', 'unavailable']),
    presentation: z.unknown().optional(),
    output: z.unknown().optional(),
  }),
]);
const messageSchema = z.object({
  id: identifier, role: z.enum(['user', 'agent']), content: z.string().max(100_000),
  timestamp: z.number().finite(), status: z.enum(['sent', 'delivered', 'error', 'streaming', 'interrupted', 'restricted']),
  partsVersion: z.unknown().optional(), parts: z.unknown().optional(),
});

/** History is external data, not trusted executable UI or a live-run checkpoint. */
export function readHistoryMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(input => {
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) return [];
    const { partsVersion, parts, ...message } = parsed.data;
    const decoded = partsVersion === 1 ? z.array(partSchema).max(100).safeParse(parts) : null;
    const safeParts: MessagePart[] | undefined = decoded?.success ? decoded.data.map(part => part.type === 'text' ? part : {
      ...part,
      status: part.status === 'running' ? 'interrupted' : part.status,
      presentation: parsePresentation(part.presentation),
      output: parseToolOutput(part.output),
    }) : undefined;
    return [{ ...message, status: message.status === 'streaming' ? 'interrupted' : message.status,
      ...(safeParts && { partsVersion: 1 as const, parts: safeParts }),
    }];
  });
}
