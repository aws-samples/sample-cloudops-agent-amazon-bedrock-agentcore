import { ConversationMetadata, ConversationFull, ConversationUpdateBody, Message } from '@/types';
import { getConversationApiEndpoint } from '@/services/config';
import { readHistoryMessages } from './messageHistory';

export class ConversationApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ConversationApiError';
  }
}

async function apiFetch<T>(path: string, token: string, options?: RequestInit): Promise<T> {
  const endpoint = import.meta.env.DEV && import.meta.env.VITE_LOCAL_API === '1'
    ? '/local-api' : getConversationApiEndpoint();
  const url = `${endpoint.replace(/\/$/, '')}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token, // Cognito ID token
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: response.statusText }));
    throw new ConversationApiError(
      errorBody.message || `Request failed with status ${response.status}`,
      response.status
    );
  }

  // 204 No Content (delete)
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json();
}

export async function listConversations(token: string): Promise<ConversationMetadata[]> {
  return apiFetch<ConversationMetadata[]>('/conversations', token);
}

export async function createConversation(
  token: string,
  body?: { conversationName?: string }
): Promise<ConversationFull> {
  return apiFetch<ConversationFull>('/conversations', token, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function getConversation(
  token: string,
  conversationId: string
): Promise<ConversationFull> {
  const conversation = await apiFetch<ConversationFull>(`/conversations/${conversationId}`, token);
  return { ...conversation, messages: readHistoryMessages(conversation.messages) };
}

export async function updateConversation(
  token: string,
  conversationId: string,
  body: ConversationUpdateBody
): Promise<ConversationFull> {
  return apiFetch<ConversationFull>(`/conversations/${conversationId}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteConversation(token: string, conversationId: string): Promise<void> {
  await apiFetch<void>(`/conversations/${conversationId}`, token, {
    method: 'DELETE',
  });
}

// Helper: append messages to a conversation (auto-save)
export async function appendMessages(
  token: string,
  conversationId: string,
  messages: Message[]
): Promise<ConversationFull> {
  return updateConversation(token, conversationId, { messages });
}
