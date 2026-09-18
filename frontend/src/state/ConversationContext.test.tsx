import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the delete-active desync fix: deleting the ACTIVE conversation must
 * report the replacement conversation id so the chat view can be resynced
 * (clear stale messages + retarget the chat session). Deleting a non-active
 * conversation returns null and leaves the current view untouched.
 */

const fetchAuthSessionMock = vi.fn();
const listConversationsMock = vi.fn();
const createConversationMock = vi.fn();
const getConversationMock = vi.fn();
const updateConversationMock = vi.fn();
const deleteConversationMock = vi.fn();
const appendMessagesMock = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: () => fetchAuthSessionMock(),
}));

vi.mock('@/services/conversationService', () => ({
  listConversations: (...a: unknown[]) => listConversationsMock(...a),
  createConversation: (...a: unknown[]) => createConversationMock(...a),
  getConversation: (...a: unknown[]) => getConversationMock(...a),
  updateConversation: (...a: unknown[]) => updateConversationMock(...a),
  deleteConversation: (...a: unknown[]) => deleteConversationMock(...a),
  appendMessages: (...a: unknown[]) => appendMessagesMock(...a),
}));

import { ConversationProvider, useConversationContext } from './ConversationContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <ConversationProvider>{children}</ConversationProvider>;
}

function conv(id: string) {
  return {
    conversationId: id,
    conversationName: `name-${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    messages: [],
  };
}

describe('ConversationContext.deleteConversation resync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAuthSessionMock.mockResolvedValue({
      tokens: { idToken: { toString: () => 'id-jwt' } },
    });
    deleteConversationMock.mockResolvedValue(undefined);
  });

  it('returns the replacement id when the ACTIVE conversation is deleted', async () => {
    createConversationMock
      .mockResolvedValueOnce(conv('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      .mockResolvedValueOnce(conv('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));

    const { result } = renderHook(() => useConversationContext(), { wrapper });

    let activeId = '';
    await act(async () => {
      activeId = await result.current.createConversation();
    });
    expect(result.current.activeConversationId).toBe(activeId);

    let replacement: string | null = null;
    await act(async () => {
      replacement = await result.current.deleteConversation(activeId);
    });

    // A fresh conversation was created and reported back for resync.
    expect(replacement).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(result.current.activeConversationId).toBe(replacement);
  });

  it('returns null when a NON-active conversation is deleted', async () => {
    createConversationMock.mockResolvedValueOnce(
      conv('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    );

    const { result } = renderHook(() => useConversationContext(), { wrapper });

    let activeId = '';
    await act(async () => {
      activeId = await result.current.createConversation();
    });

    let replacement: string | null = 'sentinel';
    await act(async () => {
      replacement = await result.current.deleteConversation('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    });

    expect(replacement).toBeNull();
    // The active conversation is unchanged, and no replacement was created.
    expect(result.current.activeConversationId).toBe(activeId);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });
});
