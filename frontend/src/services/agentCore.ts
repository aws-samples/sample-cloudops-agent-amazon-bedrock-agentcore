import { AppConfig, AgentCredentials } from '@/types';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';

export class AgentCoreError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'AgentCoreError';
  }
}

/**
 * Invokes the AgentCore Runtime via direct HTTP POST with SigV4 signing.
 *
 * Based on the original app's SDK (BedrockAgentCoreClient + InvokeAgentRuntimeCommand),
 * the HTTP wire format is:
 *
 * POST /runtimes/{URL-encoded agentRuntimeArn}/invocations
 * Host: bedrock-agentcore.{region}.amazonaws.com
 * Content-Type: application/json
 * X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {sessionId}
 * Body: the payload string directly (which is JSON.stringify({prompt, sessionId, accessToken?}))
 *
 * Key insight: The `payload` is sent as the RAW HTTP body (not wrapped in another JSON).
 * The `runtimeSessionId` is sent as a header, not in the body.
 *
 * Identity propagation: the caller passes the authenticated user's Cognito token
 * (carrying the `role` claim injected by the Pre Token Generation Lambda). It is
 * conveyed to the Agent Runtime in a dedicated `accessToken` body field, which the
 * runtime forwards to the Gateway so Policy can authorize tools against the user's role.
 * The runtime derives the per-user identity (Cognito `sub`) server-side from this
 * token; no client-supplied `userId` is trusted as identity.
 */
export async function invokeAgent(
  prompt: string,
  sessionId: string,
  config: AppConfig,
  credentials: AgentCredentials,
  accessToken?: string | null,
  signal?: AbortSignal
): Promise<string> {
  if (!config.agentcore?.enabled) {
    throw new AgentCoreError('AgentCore is not enabled in configuration');
  }

  const { region, agentArn } = config.agentcore;

  if (!region || !agentArn) {
    throw new AgentCoreError('Missing AgentCore region or agentArn in configuration');
  }

  if (!prompt.trim()) {
    throw new AgentCoreError('Prompt cannot be empty');
  }

  if (!sessionId) {
    throw new AgentCoreError('Session ID is required');
  }

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  try {
    const hostname = `bedrock-agentcore.${region}.amazonaws.com`;
    const encodedArn = encodeURIComponent(agentArn);
    const path = `/runtimes/${encodedArn}/invocations`;
    const url = `https://${hostname}${path}`;

    // The payload IS the raw HTTP body — contains the data the @app.entrypoint receives
    // The backend's invoke(payload) gets this after JSON.parse.
    //
    // Identity/trust path: the user's identity is NOT taken from any client-supplied
    // field here. It is derived server-side by the Agent Runtime from the verified
    // Cognito `sub` claim decoded out of the forwarded `accessToken`. The runtime also
    // forwards that token to the Gateway for role-based authorization.
    //
    // `userId` is retained ONLY for backward-compatible request shape and is a
    // non-identity placeholder. The runtime does NOT trust it as identity (memory,
    // conversation history, and authorization all key off the verified `sub`).
    // Do not reintroduce a real/meaningful user value here.
    const body = JSON.stringify({
      prompt,
      sessionId,
      userId: 'unused-identity-derived-server-side',
      ...(accessToken ? { accessToken } : {}),
    });

    // Sign the request with SigV4
    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      sha256: Sha256,
    });

    const request = {
      method: 'POST',
      protocol: 'https:',
      hostname,
      path,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        'host': hostname,
      },
      body,
    };

    const signedRequest = await signer.sign(request);

    // Make the HTTP request
    const response = await fetch(url, {
      method: 'POST',
      headers: signedRequest.headers as Record<string, string>,
      body,
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AgentCoreError(
        `AgentCore returned HTTP ${response.status}: ${errorText || response.statusText}`,
        response.status
      );
    }

    // Read the streaming response body
    const result = await readStreamResponse(response, signal);
    return result;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    if (error instanceof AgentCoreError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    throw new AgentCoreError(`Failed to invoke agent: ${message}`);
  }
}

/**
 * Reads the streaming response body and parses the result.
 * The response body is accumulated as text, then JSON-parsed.
 */
async function readStreamResponse(
  response: Response,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return parseAgentResult(text);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let done = false;

  try {
    while (!done) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException('Aborted', 'AbortError');
      }

      const { value, done: streamDone } = await reader.read();
      done = streamDone;

      if (value) {
        result += decoder.decode(value, { stream: true });
      }
    }

    // Flush decoder
    result += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return parseAgentResult(result);
}

/**
 * Parses the accumulated stream result.
 * The AgentCore response is JSON with a `result` field.
 */
function parseAgentResult(rawResult: string): string {
  if (!rawResult.trim()) {
    throw new AgentCoreError('Empty response from AgentCore Runtime');
  }

  try {
    const parsed = JSON.parse(rawResult);
    if (typeof parsed.result === 'string') {
      return parsed.result;
    }
    return rawResult;
  } catch {
    return rawResult;
  }
}
