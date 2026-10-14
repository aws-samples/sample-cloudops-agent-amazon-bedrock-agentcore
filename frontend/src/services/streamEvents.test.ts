import { describe, expect, it, vi } from 'vitest';
import { readEventStream } from './agentCore';
import { parseToolParts } from './streamEvents';

const encode = new TextEncoder();
const frame = (type: string, sequence: number, fields = {}) =>
  `data: ${JSON.stringify({ version: 1, runId: 'run', messageId: 'message', sequence, type, ...fields })}\n\n`;
const options = () => ({
  runId: 'run',
  messageId: 'message',
  onEvent: vi.fn(),
});
const response = (raw: string) =>
  new Response(raw, { headers: { 'content-type': 'text/event-stream' } });

describe('SSE framing and limits', () => {
  it('caps individual frames, not a coalesced HTTP chunk containing many small frames', async () => {
    const raw =
      frame('run-start', 1) +
      Array.from({ length: 1500 }, (_, i) =>
        frame('text-delta', i + 2, { text: 'x' }),
      ).join('') +
      frame('run-complete', 1502);
    expect(raw.length).toBeGreaterThan(128_000);
    expect(await readEventStream(response(raw), options())).toBe(
      'x'.repeat(1500),
    );
  });

  it('accepts CRLF event framing split between CR and LF', async () => {
    const raw = (
      frame('run-start', 1) +
      frame('text-delta', 2, { text: 'OK' }) +
      frame('run-complete', 3)
    ).replace(/\n/g, '\r\n');
    const split = raw.indexOf('\r') + 1;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encode.encode(raw.slice(0, split)));
        c.enqueue(encode.encode(raw.slice(split)));
        c.close();
      },
    });
    expect(await readEventStream(new Response(body), options())).toBe('OK');
  });

  it.each([
    ['gap', frame('run-start', 1) + frame('text-delta', 3, { text: 'lost' })],
    [
      'oversized frame',
      frame('run-start', 1) +
        frame('text-delta', 2, { text: 'x'.repeat(130_000) }),
    ],
    ['missing start', frame('run-complete', 1)],
  ])('rejects %s', async (_, raw) => {
    await expect(readEventStream(response(raw), options())).rejects.toThrow();
  });

  it('does not echo malformed server data in a parser error', async () => {
    await expect(
      readEventStream(response('data: secret-private-token\n\n'), options()),
    ).rejects.toThrow('Invalid response stream. Please retry.');
  });

  it('cancels a blocked reader on local stop', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ cancel: cancelled });
    const controller = new AbortController();
    const pending = readEventStream(
      new Response(body),
      options(),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('drops an oversized stored tool snapshot instead of rendering it', () => {
    expect(
      parseToolParts(
        Array.from({ length: 50 }, (_, i) => ({
          id: String(i),
          name: 'x',
          status: 'completed',
          presentation: {
            kind: 'resources',
            rows: Array.from({ length: 50 }, () => ({ name: 'x'.repeat(200) })),
          },
        })),
      ),
    ).toEqual([]);
  });
});
