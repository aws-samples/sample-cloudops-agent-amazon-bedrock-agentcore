/** Only versioned, allowlisted presentation data crosses into the UI/history. */
export type Presentation =
  | { kind: 'resources'; rows: Record<string, string>[] }
  | { kind: 'costs'; unit: string; points: { label: string; value: number }[] };
export interface ToolPart {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  presentation?: Presentation;
}
export interface StreamEvent {
  version: 1;
  runId: string;
  messageId: string;
  sequence: number;
  type:
    | 'run-start'
    | 'text-delta'
    | 'tool-start'
    | 'tool-complete'
    | 'tool-failure'
    | 'run-complete'
    | 'run-failure';
  text?: string;
  message?: string;
  toolCallId?: string;
  name?: string;
  presentation?: Presentation;
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const short = (x: unknown, max = 200): x is string =>
  typeof x === 'string' && x.length <= max;

export function parsePresentation(value: unknown): Presentation | undefined {
  if (!record(value)) return;
  if (
    value.kind === 'resources' &&
    Array.isArray(value.rows) &&
    value.rows.length > 0 &&
    value.rows.length <= 50
  ) {
    const fields = [
      'name',
      'region',
      'status',
      'version',
      'engine',
      'instance_class',
    ];
    if (
      value.rows.every(
        (row) =>
          record(row) &&
          short(row.name) &&
          Object.entries(row).every(([k, v]) => fields.includes(k) && short(v)),
      )
    ) {
      return {
        kind: 'resources',
        rows: value.rows as Record<string, string>[],
      };
    }
  }
  if (
    value.kind === 'costs' &&
    ['USD', 'EUR', 'GBP', 'JPY'].includes(String(value.unit)) &&
    Array.isArray(value.points) &&
    value.points.length > 0 &&
    value.points.length <= 50
  ) {
    if (
      value.points.every(
        (p) =>
          record(p) &&
          short(p.label, 40) &&
          typeof p.value === 'number' &&
          Number.isFinite(p.value),
      )
    ) {
      return {
        kind: 'costs',
        unit: String(value.unit),
        points: value.points.map((p) => ({ label: p.label, value: p.value })),
      };
    }
  }
}

export function parseToolParts(value: unknown): ToolPart[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64_000)
    return [];
  return value.flatMap((p) => {
    if (
      !record(p) ||
      !short(p.id) ||
      !short(p.name) ||
      !['running', 'completed', 'failed', 'interrupted'].includes(
        String(p.status),
      )
    )
      return [];
    return [
      {
        id: p.id,
        name: p.name,
        status: p.status as ToolPart['status'],
        presentation: parsePresentation(p.presentation),
      },
    ];
  });
}

export function parseEvent(value: unknown): StreamEvent {
  if (
    !record(value) ||
    value.version !== 1 ||
    !short(value.runId) ||
    !short(value.messageId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1
  )
    throw new Error('Invalid stream envelope');
  if (
    ![
      'run-start',
      'text-delta',
      'tool-start',
      'tool-complete',
      'tool-failure',
      'run-complete',
      'run-failure',
    ].includes(String(value.type))
  )
    throw new Error('Unsupported stream event');
  if (value.type === 'text-delta' && !short(value.text, 100_000))
    throw new Error('Invalid text delta');
  if (String(value.type).startsWith('tool-') && !short(value.toolCallId))
    throw new Error('Invalid tool identity');
  if (value.type === 'tool-start' && !short(value.name))
    throw new Error('Invalid tool name');
  // Never display raw server failures. The UI uses a fixed, actionable message.
  return {
    version: 1,
    runId: value.runId,
    messageId: value.messageId,
    sequence: Number(value.sequence),
    type: value.type as StreamEvent['type'],
    text: typeof value.text === 'string' ? value.text : undefined,
    toolCallId:
      typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    presentation: parsePresentation(value.presentation),
  };
}
