import { AppConfig } from '@/types';

export function getAppConfig(): AppConfig {
  const raw = localStorage.getItem('appConfig');
  if (!raw) {
    throw new Error(
      'App configuration not found in localStorage. Please set up the application configuration.'
    );
  }
  try {
    const parsed = JSON.parse(raw) as AppConfig;
    // Validate that required cognito section exists
    if (!parsed.cognito?.userPoolId) {
      throw new Error('Invalid app configuration: cognito.userPoolId is required.');
    }
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error('Invalid app configuration format in localStorage.');
    }
    throw e;
  }
}

export function isConfigured(): boolean {
  try {
    const raw = localStorage.getItem('appConfig');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // The chat UI always enables conversation history, so a usable
    // configuration requires BOTH Cognito auth AND the history API endpoint.
    // Requiring the endpoint here prevents proceeding to a chat whose sidebar
    // immediately fails with "Conversation API endpoint not configured"
    // (issue #20).
    return Boolean(parsed?.cognito?.userPoolId) && Boolean(parsed?.conversationApi?.endpoint);
  } catch {
    return false;
  }
}

/** Whether a non-empty conversation-history API endpoint is configured. */
export function isHistoryConfigured(): boolean {
  try {
    const raw = localStorage.getItem('appConfig');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.conversationApi?.endpoint);
  } catch {
    return false;
  }
}

/**
 * Validate that a string is a well-formed http(s) URL. Used by the setup form
 * to reject a blank or malformed Conversation History API endpoint before it is
 * persisted (issue #20).
 */
export function isValidHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function getAgentName(config: AppConfig): string {
  if (config.agentcore?.enabled && config.agentcore?.agentName) return config.agentcore.agentName;
  if (config.bedrock?.agentName) return config.bedrock.agentName;
  if (config.strands?.enabled && config.strands?.agentName) return config.strands.agentName;
  return 'CloudOps Agent';
}

export function getConversationApiEndpoint(): string {
  const config = getAppConfig();
  if (!config.conversationApi?.endpoint) {
    throw new Error('Conversation API endpoint not configured. Please update settings.');
  }
  return config.conversationApi.endpoint;
}

// ---------------------------------------------------------------------------
// Deployment-supplied configuration (issue #23: login-first hosted onboarding)
// ---------------------------------------------------------------------------
//
// The hosted app is configured once at deployment time: a build step bakes the
// stack's FrontEndConfig into `app-config.json` at the site root (see
// scripts/generate-frontend-config.sh). When that file is present and valid the
// app is authoritative-configured and goes straight to login — no setup screen,
// and no per-browser configuration. The setup form (ConfigEditor) remains as an
// opt-in path for local development or pointing at a custom backend, used only
// when no deployment config is present. Published config contains only
// non-secret values (pool IDs, ARN, API URL, Region) — never passwords, tokens,
// or OAuth secrets.

/** Path of the deployment-supplied config, relative to the app base URL. */
const DEPLOYMENT_CONFIG_FILE = 'app-config.json';

export interface ConfigLoadResult {
  /**
   * - `ready`: a usable config is available (deployment-supplied or local).
   * - `needs-setup`: no config anywhere; show the setup form (dev/custom path).
   * - `deploy-error`: deployment config is present but invalid — a deployment
   *   problem to fix at the source, NOT something an end user should repair.
   */
  status: 'ready' | 'needs-setup' | 'deploy-error';
  config?: AppConfig;
  error?: string;
}

function hasRequiredConfigShape(parsed: unknown): parsed is AppConfig {
  const c = parsed as AppConfig | undefined;
  return Boolean(
    c?.cognito?.userPoolId &&
      c?.cognito?.userPoolClientId &&
      c?.cognito?.identityPoolId &&
      c?.conversationApi?.endpoint
  );
}

type DeploymentConfigFetch =
  | { present: false }
  | { present: true; valid: true; config: AppConfig }
  | { present: true; valid: false; error: string };

async function fetchDeploymentConfig(): Promise<DeploymentConfigFetch> {
  const base = (import.meta.env.BASE_URL as string | undefined) || '/';
  const url = `${base}${DEPLOYMENT_CONFIG_FILE}`;
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    // Network/other error resolving the file — treat as "no deployment config"
    // so local development falls through to the setup form.
    return { present: false };
  }
  if (!res.ok) return { present: false };

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON — almost certainly the SPA's index.html served by a catch-all
    // rewrite when the file does not exist. Treat as absent (dev), not an error.
    return { present: false };
  }
  if (!hasRequiredConfigShape(parsed)) {
    return {
      present: true,
      valid: false,
      error:
        'The deployment configuration (app-config.json) is present but incomplete. ' +
        'It must include the Cognito user/client/identity pool IDs and the ' +
        'Conversation History API endpoint. This is a deployment configuration ' +
        'problem — please contact whoever deployed this app.',
    };
  }
  return { present: true, valid: true, config: parsed as AppConfig };
}

/**
 * Resolve the effective app configuration at startup.
 *
 * Precedence: a valid deployment-supplied `app-config.json` wins and is
 * persisted to `localStorage` so the existing synchronous {@link getAppConfig}
 * consumers work unchanged and survive reloads / new browsers without a setup
 * step. If no deployment config is present, fall back to `localStorage` (local
 * dev / custom backend); if that is also absent, request the setup form.
 */
export async function loadRuntimeConfig(): Promise<ConfigLoadResult> {
  const hosted = await fetchDeploymentConfig();
  if (hosted.present) {
    if (hosted.valid) {
      try {
        localStorage.setItem('appConfig', JSON.stringify(hosted.config));
      } catch {
        // Ignore storage failures; the returned in-memory config is still used.
      }
      return { status: 'ready', config: hosted.config };
    }
    return { status: 'deploy-error', error: hosted.error };
  }
  if (isConfigured()) {
    return { status: 'ready', config: getAppConfig() };
  }
  return { status: 'needs-setup' };
}
