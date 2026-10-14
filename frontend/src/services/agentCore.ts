import { AppConfig, AgentCredentials } from '@/types';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import { parseEvent, type StreamEvent } from './streamEvents';

export interface StreamOptions {
  runId: string;
  messageId: string;
  onEvent: (event: StreamEvent) => void;
}

export class AgentCoreError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
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
  signal?: AbortSignal,
  stream?: StreamOptions,
): Promise<string> {
  if (!config.agentcore?.enabled) {
    throw new AgentCoreError('AgentCore is not enabled in configuration');
  }

  const { region, agentArn } = config.agentcore;

  if (!region || !agentArn) {
    throw new AgentCoreError(
      'Missing AgentCore region or agentArn in configuration',
    );
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
      ...(stream
        ? {
            responseMode: 'stream-v1',
            runId: stream.runId,
            messageId: stream.messageId,
          }
        : {}),
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
        Accept: stream
          ? 'text/event-stream, application/json'
          : 'application/json',
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        host: hostname,
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
      throw new AgentCoreError(
        `AgentCore returned HTTP ${response.status}. Please retry or sign in again.`,
        response.status,
      );
    }

    // Read the streaming response body
    const result =
      stream &&
      response.headers.get('content-type')?.includes('text/event-stream')
        ? await readEventStream(response, stream, signal)
        : await readStreamResponse(response, signal);
    return result;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    if (error instanceof AgentCoreError) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    throw new AgentCoreError(`Failed to invoke agent: ${message}`);
  }
}

/** AgentCore SDK frames generator values as SSE `data: JSON\n\n`, not HTTP chunks. */
export async function readEventStream(
  response: Response,
  options: StreamOptions,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) throw new AgentCoreError('Missing response stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    text = '',
    sequence = 0,
    started = false,
    completed = false;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!completed) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      pending += value
        ? decoder.decode(value, { stream: true })
        : decoder.decode();
      // CRLF may itself straddle chunks; normalize only after finding a full frame.
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 128_000)
          throw new AgentCoreError('Stream frame is too large');
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue; // SSE comments/heartbeats
        let event: StreamEvent;
        try {
          event = parseEvent(JSON.parse(data));
        } catch {
          throw new AgentCoreError('Invalid response stream. Please retry.');
        }
        if (
          event.runId !== options.runId ||
          event.messageId !== options.messageId
        )
          continue;
        if (event.sequence <= sequence) continue; // duplicate/stale delivery
        if (event.sequence !== sequence + 1)
          throw new AgentCoreError('Missing stream event');
        if (!started && event.type !== 'run-start')
          throw new AgentCoreError('Missing stream start');
        if (started && event.type === 'run-start')
          throw new AgentCoreError('Duplicate stream start');
        started = true;
        sequence = event.sequence;
        if (event.type === 'text-delta') {
          text += event.text;
          if (text.length > 100_000)
            throw new AgentCoreError('Response is too large');
        }
        options.onEvent(event);
        if (event.type === 'run-failure')
          throw new AgentCoreError(
            'The response could not be completed. Please retry.',
          );
        if (event.type === 'run-complete') {
          completed = true;
          break;
        }
      }
      if (!completed && pending.length > 128_000)
        throw new AgentCoreError('Stream frame is too large');
      if (done) break;
    }
    if (!completed)
      throw new AgentCoreError(
        'The response ended before completion. Please retry.',
      );
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Reads the streaming response body and parses the result.
 * The response body is accumulated as text, then JSON-parsed.
 */
async function readStreamResponse(
  response: Response,
  signal?: AbortSignal,
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
    if (parsed.error)
      throw new AgentCoreError(
        'The response could not be completed. Please retry.',
      );
    return rawResult;
  } catch (error) {
    if (error instanceof AgentCoreError) throw error;
    return rawResult;
  }
}
