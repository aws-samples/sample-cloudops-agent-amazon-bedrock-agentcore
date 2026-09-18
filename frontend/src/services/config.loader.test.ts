import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadRuntimeConfig } from './config';

/**
 * Tests for issue #23: login-first hosted onboarding via a deployment-supplied
 * app-config.json baked into the bundle. loadRuntimeConfig() resolves the
 * effective configuration at startup:
 *   - valid deployment config  -> ready (and persisted to localStorage)
 *   - present but invalid       -> deploy-error (deployer fixes it, not the user)
 *   - absent + localStorage set -> ready (local dev / custom backend)
 *   - absent + no localStorage  -> needs-setup (show the setup form)
 *   - SPA index.html fallback    -> treated as absent
 */

const VALID_CONFIG = {
  cognito: {
    userPoolId: 'us-east-1_test',
    userPoolClientId: 'client',
    identityPoolId: 'us-east-1:pool',
    region: 'us-east-1',
  },
  agentcore: { enabled: true, region: 'us-east-1', agentArn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/x' },
  conversationApi: { endpoint: 'https://api.example.com/prod' },
};

function mockFetchResolvedTo(response: { ok: boolean; status?: number; body: string }) {
  globalThis.fetch = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 404),
    text: async () => response.body,
  })) as unknown as typeof fetch;
}

function mockFetchReject() {
  globalThis.fetch = vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

describe('loadRuntimeConfig (issue #23)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a valid deployment config and persists it (login-first)', async () => {
    mockFetchResolvedTo({ ok: true, body: JSON.stringify(VALID_CONFIG) });

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('ready');
    expect(result.config?.conversationApi?.endpoint).toBe(VALID_CONFIG.conversationApi.endpoint);
    // Persisted so the synchronous getAppConfig() consumers keep working.
    const stored = JSON.parse(localStorage.getItem('appConfig') || '{}');
    expect(stored.cognito.userPoolId).toBe(VALID_CONFIG.cognito.userPoolId);
  });

  it('reports a deploy-error when the deployment config is present but incomplete', async () => {
    const incomplete = { cognito: { userPoolId: 'us-east-1_test' } }; // missing client/identity + history endpoint
    mockFetchResolvedTo({ ok: true, body: JSON.stringify(incomplete) });

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('deploy-error');
    expect(result.error).toMatch(/deployment configuration/i);
    // A broken deployment config must not be written to localStorage.
    expect(localStorage.getItem('appConfig')).toBeNull();
  });

  it('falls back to localStorage when no deployment config is present', async () => {
    localStorage.setItem('appConfig', JSON.stringify(VALID_CONFIG));
    mockFetchResolvedTo({ ok: false, body: '' }); // 404

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('ready');
    expect(result.config?.cognito?.userPoolId).toBe(VALID_CONFIG.cognito.userPoolId);
  });

  it('requests setup when neither deployment config nor localStorage exists', async () => {
    mockFetchResolvedTo({ ok: false, body: '' }); // 404

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('needs-setup');
  });

  it('treats the SPA index.html fallback as no deployment config', async () => {
    mockFetchResolvedTo({ ok: true, body: '<!doctype html><html><body>app</body></html>' });

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('needs-setup'); // not deploy-error
  });

  it('treats a fetch failure as no deployment config (dev)', async () => {
    localStorage.setItem('appConfig', JSON.stringify(VALID_CONFIG));
    mockFetchReject();

    const result = await loadRuntimeConfig();

    expect(result.status).toBe('ready');
  });
});
