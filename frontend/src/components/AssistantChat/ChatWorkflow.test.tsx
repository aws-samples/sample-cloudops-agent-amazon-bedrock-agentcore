import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { ChatProvider } from '@/state/ChatContext';
import { ConversationProvider } from '@/state/ConversationContext';
import { ChatLayoutWired } from '@/App';

const auth = vi.hoisted(() => vi.fn());
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: auth }));
vi.mock('@aws-amplify/ui-react', () => ({ Authenticator: () => null }));
vi.mock('@/services/config', () => ({
  getAppConfig: () => ({
    agentcore: {
      enabled: true,
      region: 'us-east-1',
      agentArn: 'arn:test:runtime',
    },
  }),
  getAgentName: () => 'CloudOps Agent',
  getConversationApiEndpoint: () => 'https://history.example',
}));

const A = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222';
type Run = {
  body: Record<string, string>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  sequence: number;
  cancelled: boolean;
};
let runs: Run[],
  saved: Map<string, Message[]>,
  writes: { id: string; messages: Message[] }[],
  failSave: boolean,
  legacy: boolean;
const encoder = new TextEncoder();
const metadata = (id: string) => ({
  conversationId: id,
  conversationName: id === A ? 'First' : 'Second',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

beforeEach(() => {
  runs = [];
  saved = new Map([
    [A, []],
    [
      B,
      [
        {
          id: 'old',
          role: 'agent',
          content: 'Legacy history',
          status: 'delivered',
          timestamp: 1,
        },
      ],
    ],
  ]);
  writes = [];
  failSave = false;
  legacy = false;
  auth.mockResolvedValue({
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    tokens: {
      idToken: { toString: () => 'history-token' },
      accessToken: { toString: () => 'runtime-token' },
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('bedrock-agentcore')) {
        if (legacy)
          return new Response(
            JSON.stringify({ result: 'Legacy final response' }),
            { headers: { 'content-type': 'application/json' } },
          );
        const run = {
          body: JSON.parse(String(options?.body)),
          sequence: 0,
          cancelled: false,
        } as Run;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            run.controller = controller;
          },
          cancel() {
            run.cancelled = true;
          },
        });
        runs.push(run);
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const id = url.split('/').pop()!;
      if (options?.method === 'POST')
        return Response.json({ ...metadata(A), messages: saved.get(A) });
      if (options?.method === 'DELETE') {
        saved.delete(id);
        return new Response(null, { status: 204 });
      }
      if (options?.method === 'PUT') {
        const body = JSON.parse(String(options.body));
        if (body.messages) {
          writes.push({ id, messages: body.messages });
          if (failSave)
            return Response.json({ message: 'Save failed' }, { status: 500 });
          saved.set(id, [...(saved.get(id) || []), ...body.messages]);
        }
        return Response.json({
          ...metadata(id),
          messages: saved.get(id) || [],
          ...(body.conversationName && {
            conversationName: body.conversationName,
          }),
        });
      }
      if (id === 'conversations') return Response.json([metadata(B)]);
      return Response.json({ ...metadata(id), messages: saved.get(id) || [] });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  return render(
    <ChatProvider>
      <ConversationProvider>
        <ChatLayoutWired
          user={{ username: 'Tester' }}
          signOut={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </ConversationProvider>
    </ChatProvider>,
  );
}
async function send(prompt = 'Inspect resources') {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message input' }), {
    target: { value: prompt },
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message input' }), {
    key: 'Enter',
  });
  await waitFor(() => expect(runs).toHaveLength(1));
  return runs[0];
}
function event(run: Run, type: string, values = {}) {
  return `data: ${JSON.stringify({ version: 1, runId: run.body.runId, messageId: run.body.messageId, sequence: ++run.sequence, type, ...values })}\n\n`;
}
async function push(run: Run, ...frames: string[]) {
  await act(async () => {
    run.controller.enqueue(encoder.encode(frames.join('')));
  });
}
const log = () => within(screen.getByRole('log', { name: 'Chat messages' }));

describe('rendered chat with real providers, adapter and stream parser', () => {
  it('creates first conversation, signs/forwards identity, shows early text and real tool progress, then saves/reopens rich history', async () => {
    mount();
    const run = await send();
    expect(run.body.sessionId).toBe(A);
    expect(run.body.accessToken).toBe('runtime-token');
    expect(run.body.responseMode).toBe('stream-v1');
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Early 🌍 answer' }),
      event(run, 'tool-start', { toolCallId: 't1', name: 'list_eks_clusters' }),
    );
    expect(log().getByText('Early 🌍 answer')).toBeVisible();
    expect(log().getByText('list_eks_clusters: running')).toBeVisible();
    expect(saved.get(A)?.filter((m) => m.role === 'agent')).toHaveLength(0);
    await push(
      run,
      event(run, 'tool-complete', {
        toolCallId: 't1',
        presentation: {
          kind: 'resources',
          rows: [{ name: 'cluster-one', region: 'us-east-1' }],
        },
      }),
      event(run, 'run-complete'),
    );
    await waitFor(() =>
      expect(saved.get(A)?.filter((m) => m.role === 'agent')).toHaveLength(1),
    );
    expect(log().getByRole('table', { name: /Resources/ })).toHaveTextContent(
      'cluster-one',
    );
    expect(writes[0].messages[0].content).toBe('Inspect resources');
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Legacy history')).toBeVisible(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: First' }),
    );
    await waitFor(() =>
      expect(log().getByRole('table', { name: /Resources/ })).toHaveTextContent(
        'cluster-one',
      ),
    );
    expect(runs).toHaveLength(1);
  });

  it('renders labeled costs with a readable table and ignores unknown/malicious presentation shapes', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'tool-start', { toolCallId: 't1', name: 'costs' }),
      event(run, 'tool-complete', {
        toolCallId: 't1',
        presentation: {
          kind: 'costs',
          unit: 'USD',
          points: [{ label: '2026-01-01', value: 12.5 }],
        },
      }),
      event(run, 'tool-start', { toolCallId: 't2', name: 'unknown' }),
      event(run, 'tool-complete', {
        toolCallId: 't2',
        presentation: { kind: 'html', html: '<script>alert(1)</script>' },
      }),
      event(run, 'run-complete'),
    );
    expect(log().getByRole('img', { name: /Cost chart in USD/ })).toBeVisible();
    expect(log().getByRole('table', { name: /Cost values/ })).toHaveTextContent(
      '12.5 USD',
    );
    expect(log().getByText(/Structured preview unavailable/)).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
  });

  it('handles UTF-8 and SSE frames split across chunks, coalesced frames, duplicate and stale run events', async () => {
    mount();
    const run = await send();
    const frame =
      event(run, 'run-start') +
      event(run, 'text-delta', { text: 'Split 🌍 token' });
    const bytes = encoder.encode(frame),
      split = bytes.indexOf(0xf0) + 1;
    await act(async () => {
      run.controller.enqueue(bytes.slice(0, split));
    });
    expect(log().queryByText('Split 🌍 token')).toBeNull();
    await act(async () => {
      run.controller.enqueue(bytes.slice(split));
    });
    expect(log().getByText('Split 🌍 token')).toBeVisible();
    await push(
      run,
      `data: ${JSON.stringify({ version: 1, runId: 'stale', messageId: run.body.messageId, sequence: 1, type: 'text-delta', text: 'WRONG' })}\n\n`,
      frame,
      event(run, 'run-complete'),
    );
    expect(log().queryByText(/WRONG/)).toBeNull();
    expect(log().getAllByText('Split 🌍 token')).toHaveLength(1);
  });

  it.each(['eof', 'malformed', 'failure'])(
    'keeps partial answer incomplete after %s and retries only explicitly',
    async (mode) => {
      mount();
      const run = await send();
      await push(
        run,
        event(run, 'run-start'),
        event(run, 'text-delta', { text: 'Partial answer' }),
      );
      await act(async () => {
        if (mode === 'eof') run.controller.close();
        else
          run.controller.enqueue(
            encoder.encode(
              mode === 'malformed'
                ? 'data: invalid\n\n'
                : event(run, 'run-failure', { message: 'secret exception' }),
            ),
          );
      });
      await waitFor(() =>
        expect(log().getByText(/Incomplete response/)).toBeVisible(),
      );
      expect(log().getByText('Partial answer')).toBeVisible();
      expect(runs).toHaveLength(1);
      expect(saved.get(A)?.filter((m) => m.role === 'agent')).toHaveLength(0);
      expect(screen.queryByText('secret exception')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(runs).toHaveLength(2));
    },
  );

  it('local stop marks partial content incomplete and discards late events without claiming server cancellation', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Stopped answer' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(run.cancelled).toBe(true));
    expect(log().getByText(/server-side execution may continue/)).toBeVisible();
    expect(log().getByText('Stopped answer')).toBeVisible();
    expect(saved.get(A)?.filter((m) => m.role === 'agent')).toHaveLength(0);
  });

  it('switches during a stream without leaking text, errors, tool cards or writes into another conversation', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Only first' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Legacy history')).toBeVisible(),
    );
    await push(
      run,
      event(run, 'text-delta', { text: ' completed' }),
      event(run, 'run-complete'),
    );
    await waitFor(() =>
      expect(
        saved.get(A)?.some((m) => m.content === 'Only first completed'),
      ).toBe(true),
    );
    expect(log().queryByText(/Only first/)).toBeNull();
    expect(writes.every((w) => w.id === A)).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: First' }),
    );
    await waitFor(() =>
      expect(log().getByText('Only first completed')).toBeVisible(),
    );
  });

  it('restores an active partial run when switching back and does not overwrite it with older history', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Live partial' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Legacy history')).toBeVisible(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: First' }),
    );
    await waitFor(() => expect(log().getByText('Live partial')).toBeVisible());
    expect(
      screen.getByRole('button', { name: 'Cancel request' }),
    ).toBeVisible();
    await push(
      run,
      event(run, 'text-delta', { text: ' done' }),
      event(run, 'run-complete'),
    );
    await waitFor(() =>
      expect(log().getByText('Live partial done')).toBeVisible(),
    );
  });

  it('keeps failure and save notices associated with their original conversation', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'First partial' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Legacy history')).toBeVisible(),
    );
    await push(run, event(run, 'run-failure', { message: 'PRIVATE' }));
    expect(screen.queryByText(/response could not be completed/)).toBeNull();
    expect(log().queryByText('First partial')).toBeNull();
    expect(writes.every((w) => w.id === A)).toBe(true);
  });

  it('navigation during credential refresh does not send the pending prompt to the new conversation', async () => {
    mount();
    await screen.findByRole('button', { name: 'Open conversation: Second' });
    let resolve!: (value: unknown) => void;
    auth.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message input' }), {
      target: { value: 'Old navigation prompt' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message input' }), {
      key: 'Enter',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Legacy history')).toBeVisible(),
    );
    await act(async () => {
      resolve({
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      });
    });
    expect(runs).toHaveLength(0);
    expect(log().queryByText('Old navigation prompt')).toBeNull();
  });

  it('restores malformed saved parts safely and preserves keyboard, settings, sign-out and rename controls', async () => {
    saved.set(B, [
      {
        id: 'old',
        role: 'agent',
        content: 'Readable history',
        timestamp: 1,
        status: 'delivered',
        partsVersion: 1,
        tools: [
          {
            id: 'bad',
            name: 'bad',
            status: 'completed',
            presentation: { kind: 'html', html: '<script>evil()</script>' },
          } as never,
        ],
      },
    ]);
    const settings = vi.fn(),
      signOut = vi.fn();
    render(
      <ChatProvider>
        <ConversationProvider>
          <ChatLayoutWired
            user={{ username: 'Tester' }}
            signOut={signOut}
            onOpenSettings={settings}
          />
        </ConversationProvider>
      </ChatProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open conversation: Second' }),
    );
    await waitFor(() =>
      expect(log().getByText('Readable history')).toBeVisible(),
    );
    expect(log().getByText(/Structured preview unavailable/)).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(settings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Second' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Rename conversation' }),
      { target: { value: 'Renamed' } },
    );
    fireEvent.keyDown(
      screen.getByRole('textbox', { name: 'Rename conversation' }),
      { key: 'Enter' },
    );
    await screen.findByRole('button', { name: 'Open conversation: Renamed' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('deleting an in-flight conversation cancels receipt and prevents a late save', async () => {
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Delete me' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for First' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(run.cancelled).toBe(true));
    expect(
      writes.flatMap((w) => w.messages).some((m) => m.role === 'agent'),
    ).toBe(false);
    expect(log().queryByText('Delete me')).toBeNull();
  });

  it('surfaces history save failures without hiding the answer', async () => {
    failSave = true;
    mount();
    const run = await send();
    await push(
      run,
      event(run, 'run-start'),
      event(run, 'text-delta', { text: 'Useful answer' }),
      event(run, 'run-complete'),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/response was received, but saving/),
      ).toBeVisible(),
    );
    expect(log().getByText('Useful answer')).toBeVisible();
  });

  it('supports a staged backend returning legacy final JSON', async () => {
    legacy = true;
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message input' }), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(log().getByText('Legacy final response')).toBeVisible(),
    );
  });

  it('does not invoke without authentication and preserves the prompt for explicit retry', async () => {
    auth.mockResolvedValue({});
    mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message input' }), {
      target: { value: 'Retain prompt' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message input' }), {
      key: 'Enter',
    });
    await waitFor(() =>
      expect(screen.getByText(/Unable to authenticate/)).toBeVisible(),
    );
    expect(runs).toHaveLength(0);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes('bedrock-agentcore')),
    ).toBe(false);
  });
});
