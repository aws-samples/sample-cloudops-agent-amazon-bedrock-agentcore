// Adapted from assistant-ui/tool-ui (MIT), revision 49a870286facdbf28160cd647f0d337ebdc9b275.
// Reduced to read-only CloudOps results; bounded payloads and no generated actions/styles.
import { z } from 'zod';

const label = z.string().max(200);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const cell = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const common = { id: z.string().min(1).max(128), title: label };

const tableSchema = z.object({
  ...common,
  kind: z.literal('table'),
  emptyMessage: label.optional(),
  columns: z.array(z.object({ key, label })).min(1).max(8),
  data: z.array(z.record(key, cell)).max(50),
}).refine(value => new Set(value.columns.map(column => column.key)).size === value.columns.length);

const chartSchema = z.object({
  ...common,
  kind: z.literal('chart'),
  unit: z.string().regex(/^[A-Z]{3}$/),
  xKey: z.literal('label'),
  series: z.tuple([z.object({ key: z.literal('amount'), label })]),
  data: z.array(z.object({ label, amount: z.number().finite() })).min(1).max(30),
});

export const presentationSchema = z.union([tableSchema, chartSchema]);
export type Presentation = z.infer<typeof presentationSchema>;

export function parsePresentation(value: unknown): Presentation | undefined {
  const result = presentationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
