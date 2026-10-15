import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import App from './App';

const auth = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('aws-amplify/auth', () => ({ fetchAuthSession: auth.session }));
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));
vi.mock('@aws-amplify/ui-react', () => ({
  Authenticator: ({ children }: { children: (props: object) => ReactNode }) =>
    children({ user: { username: 'operator' }, signOut: vi.fn() }),
}));

const conversationId = '11111111-1111-4111-8111-111111111111';
const config = {
  cognito: { userPoolId: 'pool', userPoolClientId: 'client', identityPoolId: 'identity', region: 'us-east-1' },
  agentcore: { enabled: true, region: 'us-east-1', agentArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test' },
  conversationApi: { endpoint: 'https://history.example.test' },
};
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function server(options: { legacy?: string; history?: Record<string, unknown>[]; existing?: boolean; saveFailure?: boolean; saveGate?: Promise<void>; autoName?: boolean } = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const saved: Record<string, unknown>[] = [...options.history ?? []];
  const otherId = '22222222-2222-4222-8222-222222222222';
  const otherMessages: Record<string, unknown>[] = [];
  const invocations: Record<string, unknown>[] = [];
  const requests: { url: string; headers: Headers }[] = [];
  const names = new Map([[conversationId, options.autoName ? 'New Conversation 2026-10-14' : 'Investigation'], [otherId, 'Other conversation']]);
  const conversation = (id = conversationId) => ({ conversationId: id, conversationName: names.get(id), createdAt: '2026-01-01', updatedAt: '2026-01-01', messages: id === conversationId ? saved : otherMessages });
  const removed = new Set<string>();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith('app-config.json')) return json(config);
    if (url.includes('bedrock-agentcore.') || url === '/local-api/invocations') {
      invocations.push(JSON.parse(String(init?.body)));
      if (options.legacy !== undefined) return json({ result: options.legacy });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/conversations') && init?.method === 'POST') return json(conversation());
    if (url.endsWith('/conversations')) return json(options.existing || options.history ? [conversation(), conversation(otherId)] : []);
    if (url.endsWith(conversationId) || url.endsWith(otherId)) {
      if (init?.method === 'PUT' && options.saveGate) await options.saveGate;
      if (init?.method === 'PUT' && options.saveFailure) return new Response('', { status: 500 });
      const id = url.endsWith(otherId) ? otherId : conversationId;
      if (init?.method === 'DELETE') { removed.add(id); return new Response(null, { status: 204 }); }
      if (removed.has(id)) return new Response('', { status: 404 });
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        if (body.conversationName) names.set(id, body.conversationName);
        if (options.autoName && conversation(id).messages.length === 0 && names.get(id)?.startsWith('New Conversation')) {
          const firstUser = body.messages?.find((message: { role: string }) => message.role === 'user');
          if (firstUser) names.set(id, firstUser.content.length > 50 ? firstUser.content.slice(0, 50) + '…' : firstUser.content);
        }
        conversation(id).messages.push(...body.messages ?? []);
      }
      return json(conversation(id));
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  return {
    saved, invocations, otherMessages, requests,
    async event(sequence: number, type: string, fields: object = {}) {
      await act(async () => {
        controller!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, runId: 'run-1', messageId: 'answer-1', sequence, type, ...fields })}\n\n`));
      });
    },
    async bytes(bytes: Uint8Array) { await act(async () => { controller!.enqueue(bytes); }); },
    async close() { await act(async () => controller!.close()); },
  };
}

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollTo = () => {};
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  auth.session.mockResolvedValue({
    tokens: { accessToken: { toString: () => 'access-jwt', payload: { role: 'admin' } }, idToken: { toString: () => 'id-jwt', payload: { role: 'admin' } } },
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test-secret', sessionToken: 'test-session' },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('CloudOps chat workflow', () => {
  it('provides a searchable history sidebar and starter suggestions in the new workspace', async () => {
    server({ existing: true });
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Search conversations' });
    await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.type(search, 'Other'); });
    expect(screen.queryByRole('button', { name: 'Open conversation: Investigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open conversation: Other conversation' })).toBeVisible();
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Investigate costs' })); });
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveValue('Help me investigate my AWS costs for the last 7 days.');
    expect(screen.getAllByRole('button', { name: 'New Conversation' })).toHaveLength(1);
  });

  it('shows real tool activity and renders a completed resource table', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'List databases{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'tool-1', toolName: 'inventory___list_rds_instances' });
    expect(await screen.findByText('Running')).toBeVisible();
    await api.event(2, 'tool-complete', {
      toolCallId: 'tool-1', toolName: 'inventory___list_rds_instances',
      presentation: { kind: 'table', id: 'tool-1', title: 'Resources', columns: [{ key: 'id', label: 'Resource' }, { key: 'engine', label: 'Engine' }], data: [{ id: 'orders-db', engine: 'postgres' }] },
    });
    expect(await screen.findByRole('table', { name: 'Resources' })).toHaveTextContent('orders-db');
    expect(screen.getByText('Completed')).toBeVisible();
    await api.event(3, 'run-complete');
    await waitFor(() => expect(api.saved.find(message => message.role === 'agent')).toHaveProperty('parts'));
  });

  it('marks a locally stopped response incomplete and does not automatically retry', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'text-delta', { text: 'Partial finding' });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Stop receiving response' })); });
    expect(await screen.findByText(/Incomplete response/)).toBeVisible();
    expect(screen.getByText('Partial finding')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
    expect(api.invocations).toHaveLength(1);
    expect(api.saved.filter(message => message.role === 'agent' && message.status === 'delivered')).toHaveLength(0);
  });

  it('restores an active stream when switching away and back without mixing conversations', async () => {
    const api = server({ existing: true });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Investigation' })); });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'text-delta', { text: 'Live finding' });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Other conversation' })); });
    expect(screen.queryByText('Live finding')).not.toBeInTheDocument();
    await api.event(2, 'text-delta', { text: ' from the first run' });
    expect(screen.queryByText(/Live finding/)).not.toBeInTheDocument();
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Investigation' })); });
    expect(await screen.findByText('Live finding from the first run')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop receiving response' })).toBeEnabled();
    await api.event(3, 'run-complete');
    await waitFor(() => expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(1));
    expect(api.otherMessages).toHaveLength(0);
  });

  it('reopens saved charts and safely falls back for invalid stored parts', async () => {
    server({ history: [
      { id: 'old', role: 'agent', content: 'Historical summary', status: 'delivered', timestamp: 1 },
      { id: 'chart', role: 'agent', content: 'Costs', status: 'delivered', timestamp: 2, partsVersion: 1, parts: [
        { type: 'tool', toolCallId: 'cost-1', toolName: 'cost_explorer', status: 'completed', presentation: {
          kind: 'chart', id: 'cost-1', title: 'Daily cost', unit: 'USD', xKey: 'label', series: [{ key: 'amount', label: 'Cost' }], data: [{ label: '2026-10-01', amount: 12.34 }],
        } },
      ] },
      { id: 'invalid', role: 'agent', content: 'Saved fallback', status: 'delivered', timestamp: 3, partsVersion: 1, parts: [null, { type: 'executable', script: 'bad' }] },
    ] });
    const user = userEvent.setup();
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.click(open); });
    expect(await screen.findByText('Historical summary')).toBeVisible();
    expect(screen.getByRole('figure', { name: 'Daily cost' })).toBeVisible();
    await act(async () => { await user.click(screen.getByText('View chart data')); });
    expect(screen.getByRole('table', { name: 'Daily cost data' })).toHaveTextContent('12.34');
    expect(screen.getByText('Saved fallback')).toBeVisible();
  });

  it.each(['disconnect', 'bad-json', 'sequence-gap'])('keeps partial output incomplete after %s without automatically rerunning', async failure => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'text-delta', { text: 'Partial evidence' });
    if (failure === 'disconnect') await api.close();
    if (failure === 'bad-json') await api.bytes(new TextEncoder().encode('data: {broken\n\n'));
    if (failure === 'sequence-gap') await api.event(3, 'run-complete');
    expect(await screen.findByText(/Incomplete response/)).toBeVisible();
    expect(screen.getByText('Partial evidence')).toBeVisible();
    expect(screen.getByRole('alert')).toBeVisible();
    expect(api.invocations).toHaveLength(1);
  });

  it('accepts split UTF-8 and SSE frames and ignores duplicate or foreign-run events', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, runId: 'run-1', messageId: 'answer-1', sequence: 1, type: 'text-delta', text: 'Coût €' })}\r\n\r\n`);
    for (const byte of frame) await api.bytes(new Uint8Array([byte]));
    await api.event(1, 'text-delta', { text: 'DUPLICATE' });
    await api.event(2, 'text-delta', { runId: 'other-run', text: 'FOREIGN' });
    await api.event(2, 'run-complete');
    expect(await screen.findByText('Coût €')).toBeVisible();
    expect(screen.queryByText(/DUPLICATE|FOREIGN/)).not.toBeInTheDocument();
  });

  it('uses a legacy JSON response and surfaces history save failure', async () => {
    const api = server({ legacy: 'Legacy answer', saveFailure: true });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Costs{Enter}'); });
    expect(await screen.findByText('Legacy answer')).toBeVisible();
    expect(screen.getByText(/Saving to conversation history failed/)).toBeVisible();
    expect(api.invocations).toHaveLength(1);
  });

  it('shows an authentication recovery error when credentials have expired', async () => {
    const api = server();
    auth.session.mockRejectedValue(new Error('expired credentials'));
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    expect(await screen.findByText(/Sign in again to send/)).toBeVisible();
    expect(api.invocations).toHaveLength(0);
  });

  it('does not save a late response into a deleted conversation', async () => {
    const api = server({ existing: true });
    const user = userEvent.setup();
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.click(open); });
    await act(async () => { await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'text-delta', { text: 'Temporary answer' });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Other conversation' })); });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Actions for Investigation' })); });
    await act(async () => { await user.click(screen.getByRole('menuitem', { name: 'Delete' })); });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Confirm delete' })); });
    expect(screen.queryByRole('button', { name: 'Open conversation: Investigation' })).not.toBeInTheDocument();
    expect(screen.queryByText('Temporary answer')).not.toBeInTheDocument();
    expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(0);
  });

  it('rejects a stream that completes while a tool is still running', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'tool-1', toolName: 'inventory' });
    await api.event(2, 'run-complete');
    expect(await screen.findByText(/Incomplete response/)).toBeVisible();
    expect(screen.getByText('Interrupted')).toBeVisible();
    expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(0);
  });

  it('preserves multiline keyboard input and blocks empty submissions', async () => {
    const api = server({ legacy: 'Done' });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    expect(input).toHaveAttribute('maxlength', '2000');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await act(async () => { await user.type(input, 'First line{Shift>}{Enter}{/Shift}Second line'); });
    expect(api.invocations).toHaveLength(0);
    await act(async () => { await user.keyboard('{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    expect(api.invocations[0].prompt).toBe('First line\nSecond line');
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
  });

  it('accepts the next question while completed history is still saving', async () => {
    let releaseSave!: () => void;
    const api = server({ legacy: 'Done', saveGate: new Promise<void>(resolve => { releaseSave = resolve; }) });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'First question{Enter}'); });
    await screen.findByText('Done');
    await act(async () => { await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Second question{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(2));
    await act(async () => { releaseSave(); });
    await waitFor(() => expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(2));
    expect(api.saved.map(message => message.content)).toEqual(['First question', 'Done', 'Second question', 'Done']);
  });

  it('keeps a failed history-save warning when reopening the conversation', async () => {
    server({ legacy: 'Unsaved answer', existing: true, saveFailure: true });
    const user = userEvent.setup();
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.click(open); });
    await act(async () => { await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'Investigate{Enter}'); });
    await screen.findByText(/Saving to conversation history failed/);
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Other conversation' })); });
    expect(screen.queryByText(/Saving to conversation history failed/)).not.toBeInTheDocument();
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Open conversation: Investigation' })); });
    expect(await screen.findByText(/Saving to conversation history failed/)).toBeVisible();
    expect(screen.getByText('Unsaved answer')).toBeVisible();
  });

  it('routes a full local-dev exchange through the local API without changing login identity', async () => {
    vi.stubEnv('VITE_LOCAL_API', '1');
    const api = server({ legacy: 'Local runtime answer' });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Local investigation{Enter}'); });
    expect(await screen.findByText('Local runtime answer')).toBeVisible();
    expect(api.requests.some(request => request.url === '/local-api/invocations')).toBe(true);
    expect(api.requests.some(request => request.url === '/local-api/conversations')).toBe(true);
    expect(api.requests.some(request => request.url.includes('bedrock-agentcore.'))).toBe(false);
    expect(api.invocations[0].accessToken).toBe('access-jwt');
    expect(api.requests.find(request => request.url === '/local-api/invocations')?.headers.has('x-amz-security-token')).toBe(false);
  });

  it('opens connection settings and returns to the workspace without losing the session', async () => {
    server();
    const user = userEvent.setup();
    render(<App />);
    const settings = await screen.findByRole('button', { name: 'Open settings' });
    await act(async () => { await user.click(settings); });
    expect(await screen.findByRole('heading', { name: 'Workspace settings' })).toBeVisible();
    expect(screen.getByLabelText('User Pool ID')).toHaveValue('pool');
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Back to workspace' })); });
    expect(await screen.findByRole('textbox', { name: 'Message input' })).toBeEnabled();
  });

  it('renames a conversation and preserves the title when rename is cancelled', async () => {
    server({ existing: true });
    const user = userEvent.setup();
    render(<App />);
    const actions = await screen.findByRole('button', { name: 'Actions for Investigation' });
    await act(async () => { await user.click(actions); });
    await act(async () => { await user.click(screen.getByRole('menuitem', { name: 'Rename' })); });
    const rename = screen.getByRole('textbox', { name: 'Rename conversation' });
    await act(async () => { await user.clear(rename); await user.type(rename, 'Database review{Enter}'); });
    expect(await screen.findByRole('button', { name: 'Open conversation: Database review' })).toBeVisible();
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Actions for Database review' })); });
    await act(async () => { await user.click(screen.getByRole('menuitem', { name: 'Rename' })); });
    await act(async () => { await user.type(screen.getByRole('textbox', { name: 'Rename conversation' }), ' changed{Escape}'); });
    expect(screen.getByRole('button', { name: 'Open conversation: Database review' })).toBeVisible();
  });

  it('preserves fenced code text in a real answer', async () => {
    server({ legacy: '```json\n{"region":"us-east-1","count":2}\n```' });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Show JSON{Enter}'); });
    expect(await screen.findByText('{"region":"us-east-1","count":2}')).toBeVisible();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('shows a successful alarm preview and does not call missing previews failures', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Check alarms{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'alarms', toolName: 'cloudwatchMcp___get_active_alarms' });
    await api.event(2, 'tool-complete', { toolCallId: 'alarms', toolName: 'cloudwatchMcp___get_active_alarms', presentation: {
      kind: 'table', id: 'alarms', title: 'Active alarms', emptyMessage: 'No active alarms found.',
      columns: [{ key: 'alarm_name', label: 'Alarm' }], data: [],
    } });
    expect(await screen.findByText('No active alarms found.')).toBeVisible();
    await api.event(3, 'tool-start', { toolCallId: 'other', toolName: 'cloudwatchMcp___get_metric_data' });
    await api.event(4, 'tool-complete', { toolCallId: 'other', toolName: 'cloudwatchMcp___get_metric_data' });
    await api.event(5, 'run-complete');
    const region = screen.getByRole('region', { name: 'Tool: cloudwatchMcp___get_metric_data' });
    await act(async () => { await user.click(within(region).getByText('get metric data')); });
    expect(within(region).getByText(/predates raw-output capture/)).toBeVisible();
    expect(screen.queryByText(/Structured preview unavailable/)).not.toBeInTheDocument();
  });

  it('returns keyboard focus to the sidebar toggle when the mobile drawer closes', async () => {
    vi.stubGlobal('innerWidth', 390);
    server();
    const user = userEvent.setup();
    render(<App />);
    const toggle = await screen.findByRole('button', { name: 'Toggle sidebar' });
    await act(async () => { await user.click(toggle); });
    expect(await screen.findByRole('dialog')).toBeVisible();
    await act(async () => { await user.keyboard('{Escape}'); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toggle).toHaveFocus();
  });

  it('ignores local API configuration outside development mode', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_LOCAL_API', '1');
    const api = server({ legacy: 'Deployed runtime answer' });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate{Enter}'); });
    expect(await screen.findByText('Deployed runtime answer')).toBeVisible();
    expect(api.requests.some(request => request.url.startsWith('/local-api'))).toBe(false);
    const invocation = api.requests.find(request => request.url.includes('bedrock-agentcore.'));
    expect(invocation?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(api.requests.some(request => request.url.startsWith('https://history.example.test'))).toBe(true);
  });

  it('lets users inspect and copy a raw tool result and restores it from history', async () => {
    const api = server();
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const view = render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Get metric data{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    const output = { json: JSON.stringify({ toolUseId: 'metric', status: 'success', content: [{ json: { values: [12, 18], apiKey: '[REDACTED]' } }] }), redacted: true, truncated: false };
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'metric', toolName: 'cloudwatchMcp___get_metric_data' });
    await api.event(2, 'tool-complete', { toolCallId: 'metric', toolName: 'cloudwatchMcp___get_metric_data', output });
    await api.event(3, 'run-complete');
    const region = screen.getByRole('region', { name: 'Tool: cloudwatchMcp___get_metric_data' });
    await act(async () => { await user.click(within(region).getByText('get metric data')); });
    await act(async () => { await user.click(within(region).getByText('Raw JSON')); });
    expect(within(region).getByLabelText('Raw tool output')).toHaveTextContent('"values"');
    expect(within(region).getByText('Sensitive fields redacted')).toBeVisible();
    await act(async () => { await user.click(within(region).getByRole('button', { name: 'Copy tool output' })); });
    expect(clipboard).toHaveBeenCalledWith(JSON.stringify(JSON.parse(output.json), null, 2));
    await waitFor(() => expect(api.saved.find(message => message.role === 'agent')).toHaveProperty('parts'));
    view.unmount();
    server({ history: api.saved });
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.click(open); });
    const restored = screen.getByRole('region', { name: 'Tool: cloudwatchMcp___get_metric_data' });
    await act(async () => { await user.click(within(restored).getByText('get metric data')); });
    await act(async () => { await user.click(within(restored).getByText('Raw JSON')); });
    expect(within(restored).getByLabelText('Raw tool output')).toHaveTextContent('"values"');
  });

  it('updates the conversation title from the first saved prompt before the answer finishes', async () => {
    const api = server({ autoName: true });
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Help me investigate my AWS costs for the last 7 days.{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'Open conversation: Help me investigate my AWS costs for the last 7 da…' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Help me investigate my AWS costs for the last 7 da…' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open conversation: New Conversation 2026-10-14' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop receiving response' })).toBeEnabled();
    await api.event(0, 'run-start');
    await api.event(1, 'run-complete');
  });

  it('does not cut off an active streaming investigation at the old 60-second deadline', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate costs'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => { screen.getByRole('button', { name: 'Send message' }).click(); });
      expect(api.invocations).toHaveLength(1);
      await api.event(0, 'run-start');
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
      await api.event(1, 'text-delta', { text: 'Analyzing the cost data.' });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(screen.queryByText(/Incomplete response/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop receiving response' })).toBeEnabled();
      await api.event(2, 'run-complete');
    } finally { vi.useRealTimers(); }
  });

  it.each(['nonadmin', undefined, 'unexpected'])('offers billing, pricing, and a clearly labeled admin-only example for role %s', async role => {
    const api = server();
    const user = userEvent.setup();
    auth.session.mockResolvedValue({
      tokens: { accessToken: { toString: () => 'access-jwt', payload: { role } }, idToken: { toString: () => 'id-jwt', payload: { role } } },
      credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test-secret' },
    });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Compare AWS pricing' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Investigate costs' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check operational health' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Explore resource inventory' })).not.toBeInTheDocument();
    expect(screen.getByText('Billing and pricing are available for your role.')).toBeVisible();
    const restricted = screen.getByRole('button', { name: 'Check CloudWatch alarms (admin-only)' });
    expect(restricted).toBeVisible();
    expect(restricted).toHaveTextContent('See how restricted access is handled');
    await act(async () => { await user.click(restricted); });
    expect(screen.getByRole('textbox', { name: 'Message input' })).toHaveValue('Check the active CloudWatch alarms in us-east-1 and summarize which resources need attention.');
    expect(api.invocations).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Access restricted' })).not.toBeInTheDocument();
  });

  it('shows operational suggestions only with the admin claim', async () => {
    server();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Check operational health' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Explore resource inventory' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check CloudWatch alarms (admin-only)' })).not.toBeInTheDocument();
  });

  it('shows a persistent access-restricted state for a real policy denial without Retry', async () => {
    const api = server();
    const user = userEvent.setup();
    const view = render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Check alarms{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'blocked-1', toolName: 'cloudwatchMcp___get_active_alarms' });
    await api.event(2, 'tool-error', { toolCallId: 'blocked-1', toolName: 'cloudwatchMcp___get_active_alarms', code: 'access-denied' });
    await api.event(3, 'run-complete');
    const card = await screen.findByRole('region', { name: 'Access restricted' });
    expect(card).toHaveTextContent('Your current access does not allow this action.');
    expect(card).toHaveTextContent('Ask an administrator');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    await waitFor(() => expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(1));
    view.unmount();
    server({ history: api.saved });
    render(<App />);
    const open = await screen.findByRole('button', { name: 'Open conversation: Investigation' });
    await act(async () => { await user.click(open); });
    expect(await screen.findByRole('region', { name: 'Access restricted' })).toBeVisible();
  });

  it('shows run-level access denial as restricted, not an interrupted response', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Check permissions{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'run-error', { code: 'access-denied' });
    expect(await screen.findByRole('region', { name: 'Access restricted' })).toBeVisible();
    expect(screen.queryByText(/Incomplete response/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows actual backend stages instead of a generic indefinite investigation', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate costs{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'run-stage', { stage: 'discovering-tools' });
    expect(await screen.findByText('Checking available tools')).toBeVisible();
    await api.event(2, 'run-stage', { stage: 'waiting-model' });
    expect(await screen.findByText('Waiting for the model')).toBeVisible();
    await api.event(3, 'run-stage', { stage: 'model-retry' });
    expect(await screen.findByText('Model is busy. Waiting to retry')).toBeVisible();
    await api.event(4, 'text-delta', { text: 'Cost analysis' });
    expect(await screen.findByText('Receiving the response')).toBeVisible();
    await api.event(5, 'run-complete');
    expect(screen.queryByText('Waiting for the model')).not.toBeInTheDocument();
  });

  it.each(['idle', 'total'])('reports an explicit %s timeout without automatically rerunning', async limit => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate costs'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => { screen.getByRole('button', { name: 'Send message' }).click(); });
      await api.event(0, 'run-start');
      if (limit === 'total') {
        for (let sequence = 1; sequence <= 5; sequence++) {
          await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
          await api.event(sequence, 'text-delta', { text: 'More evidence. ' });
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(100_001); });
      } else {
        await act(async () => { await vi.advanceTimersByTimeAsync(130_001); });
      }
      expect(screen.getByRole('alert')).toHaveTextContent(limit === 'total'
        ? 'The investigation reached the 10-minute time limit.'
        : 'No new response was received for 130 seconds.');
      if (limit === 'total') expect(screen.getByText(/More evidence/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(api.invocations).toHaveLength(1);
      expect(screen.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });

  it('shows catalogue-based access restrictions without claiming a policy denial or hiding their JSON', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Check alarms{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'notice', toolName: 'report_access_restricted' });
    await api.event(2, 'tool-complete', { toolCallId: 'notice', toolName: 'report_access_restricted', code: 'capability-unavailable',
      output: { json: JSON.stringify({ capability: 'cloudwatch', available: false, accessNotice: 'capability-unavailable' }), redacted: false, truncated: false } });
    await api.event(3, 'run-complete');
    const card = await screen.findByRole('region', { name: 'Access restricted' });
    await act(async () => { await user.click(within(card).getByText('Raw JSON')); });
    expect(within(card).getByRole('region', { name: 'Raw tool output' })).toHaveTextContent('capability-unavailable');
    expect(card).toHaveTextContent('This capability is not available in your current workspace. No restricted tool was invoked.');
    expect(card).not.toHaveTextContent('Your current access does not allow this action.');
    expect(card).not.toHaveTextContent('policy');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('keeps unavailable-tool results distinct from access denials and preserves their raw JSON', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Check alarms{Enter}'); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'tool-start', { toolCallId: 'missing', toolName: 'unregistered_tool' });
    await api.event(2, 'tool-error', { toolCallId: 'missing', toolName: 'unregistered_tool', code: 'tool-unavailable',
      output: { json: JSON.stringify({ status: 'error', content: [{ text: 'Tool not found in registry' }] }), redacted: false, truncated: false } });
    await api.event(3, 'run-complete');
    const card = await screen.findByRole('region', { name: 'Capability unavailable' });
    expect(screen.queryByRole('region', { name: 'Access restricted' })).not.toBeInTheDocument();
    await act(async () => { await user.click(within(card).getByText('Raw JSON')); });
    expect(within(card).getByRole('region', { name: 'Raw tool output' })).toHaveTextContent('Tool not found in registry');
    await act(async () => { await user.click(within(card).getByRole('button', { name: 'Copy tool output' })); });
    expect(within(card).getByRole('button', { name: 'Copy tool output' })).toHaveTextContent('Copied');
  });

  it('starts with an accessible investigation prompt', async () => {
    server();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'What would you like to investigate?' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar navigation' })).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Conversation list' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
  });

  it('shows an answer before the stream completes and saves the completed answer', async () => {
    const api = server();
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message input' });
    await act(async () => { await user.type(input, 'Investigate my resources'); });
    await act(async () => { await user.click(screen.getByRole('button', { name: 'Send message' })); });
    await waitFor(() => expect(api.invocations).toHaveLength(1));
    await api.event(0, 'run-start');
    await api.event(1, 'text-delta', { text: 'Checking your resources.' });
    expect(await within(screen.getByLabelText('Agent message')).findByText('Checking your resources.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop receiving response' })).toBeEnabled();
    expect(api.saved.filter(message => message.role === 'agent')).toHaveLength(0);
    await api.event(2, 'text-delta', { text: ' Investigation complete.' });
    await api.event(3, 'run-complete');
    await waitFor(() => expect(api.saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'agent', content: 'Checking your resources. Investigation complete.', status: 'delivered' }),
    ])));
    expect(api.invocations[0]).toMatchObject({ accessToken: 'access-jwt', sessionId: conversationId, responseMode: 'stream-v1' });
  });
});
