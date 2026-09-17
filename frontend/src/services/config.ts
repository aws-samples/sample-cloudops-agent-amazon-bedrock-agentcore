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
