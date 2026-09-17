import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for issue #19: first-chat history persistence.
 *
 *  - When persisting a message to conversation history fails, ChatContext must
 *    surface a non-blocking `saveError` instead of swallowing it as
 *    "Non-critical" (so the user is not misled into thinking it was stored).
 *  - `setSessionId` must retarget persistence: App.tsx creates a real
 *    (UUID) conversation before the first send and calls `setSessionId(newId)`,
 *    so messages must be saved against that id rather than the transient client
 *    session id the history API rejects with HTTP 400.
 */

const fetchAuthSessionMock = vi.fn();
const invokeAgentMock = vi.fn();
const appendMessagesMock = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: () => fetchAuthSessionMock(),
}));

vi.mock('@/services/agentCore', () => ({
  invokeAgent: (...args: unknown[]) => invokeAgentMock(...args),
  AgentCoreError: class AgentCoreError extends Error {},
}));

vi.mock('@/services/config', () => ({
  getAppConfig: () => ({
    cognito: {
      userPoolId: 'us-east-1_test',
      userPoolClientId: 'client',
      identityPoolId: 'pool',
      region: 'us-east-1',
    },
    agentcore: { enabled: true, region: 'us-east-1', agentArn: 'arn:test' },
  }),
}));

vi.mock('@/services/conversationService', () => ({
  appendMessages: (...args: unknown[]) => appendMessagesMock(...args),
}));

import { ChatProvider, useChatContext } from './ChatContext';

const credentials = { accessKeyId: 'AKIA', secretAccessKey: 'secret' };

function wrapper({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

function authedSession() {
  return {
    tokens: {
      accessToken: { toString: () => 'access-jwt' },
      idToken: { toString: () => 'id-jwt' },
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChatContext persistence (issue #19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAuthSessionMock.mockResolvedValue(authedSession());
    invokeAgentMock.mockResolvedValue('agent reply');
  });

  it('surfaces a saveError when persisting a message fails', async () => {
    appendMessagesMock.mockRejectedValue(new Error('400 Invalid conversationId format'));

    const { result } = renderHook(() => useChatContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('hello', credentials);
      await flush();
    });

    expect(appendMessagesMock).toHaveBeenCalled();
    expect(result.current.saveError).not.toBeNull();
    expect(result.current.saveError).toMatch(/conversation history/i);
  });

  it('leaves saveError null when persistence succeeds', async () => {
    appendMessagesMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useChatContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('hello', credentials);
      await flush();
    });

    expect(appendMessagesMock).toHaveBeenCalled();
    expect(result.current.saveError).toBeNull();
  });

  it('dismissSaveError clears a surfaced notice', async () => {
    appendMessagesMock.mockRejectedValue(new Error('save failed'));

    const { result } = renderHook(() => useChatContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('hello', credentials);
      await flush();
    });
    expect(result.current.saveError).not.toBeNull();

    act(() => {
      result.current.dismissSaveError();
    });
    expect(result.current.saveError).toBeNull();
  });

  it('persists messages against the conversation id set via setSessionId', async () => {
    appendMessagesMock.mockResolvedValue(undefined);
    const conversationId = '11111111-1111-4111-8111-111111111111';

    const { result } = renderHook(() => useChatContext(), { wrapper });

    // App.tsx installs the created conversation UUID before the first send.
    act(() => {
      result.current.setSessionId(conversationId);
    });

    await act(async () => {
      await result.current.sendMessage('hello', credentials);
      await flush();
    });

    // Every persistence call targets the synced conversation id (arg index 1),
    // not the transient client session id.
    expect(appendMessagesMock).toHaveBeenCalled();
    for (const call of appendMessagesMock.mock.calls) {
      expect(call[1]).toBe(conversationId);
    }
  });
});
