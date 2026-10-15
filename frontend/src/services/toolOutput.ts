import { z } from 'zod';

export const toolOutputSchema = z.object({
  json: z.string().max(24_000).refine(value => {
    try { JSON.parse(value); return true; }
    catch { return false; }
  }, 'Tool output must be valid JSON'),
  redacted: z.boolean(),
  truncated: z.boolean(),
});

export type ToolOutput = z.infer<typeof toolOutputSchema>;

export function parseToolOutput(value: unknown): ToolOutput | undefined {
  const result = toolOutputSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
