import React, { createContext, useContext, useReducer, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import {
  ConversationState,
  ConversationAction,
  ConversationMetadata,
  Message,
} from '@/types';
import {
  listConversations,
  createConversation as apiCreateConversation,
  getConversation,
  updateConversation,
  deleteConversation as apiDeleteConversation,
  appendMessages,
} from '@/services/conversationService';

// --- Auth token helper ---

async function getAuthToken(): Promise<string> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Unable to retrieve auth token');
  return token;
}

// --- Reducer ---

const initialState: ConversationState = {
  conversations: [],
  activeConversationId: null,
  isLoadingList: false,
  isLoadingConversation: false,
  listError: null,
  conversationError: null,
};

function conversationReducer(
  state: ConversationState,
  action: ConversationAction
): ConversationState {
  switch (action.type) {
    case 'SET_CONVERSATIONS':
      return { ...state, conversations: action.payload };
    case 'SET_ACTIVE':
      return { ...state, activeConversationId: action.payload };
    case 'ADD_CONVERSATION':
      return { ...state, conversations: [action.payload, ...state.conversations] };
    case 'REMOVE_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.filter(
          (c) => c.conversationId !== action.payload
        ),
      };
    case 'RENAME_CONVERSATION':
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.conversationId === action.payload.id
            ? { ...c, conversationName: action.payload.name }
            : c
        ),
      };
    case 'SET_LOADING_LIST':
      return { ...state, isLoadingList: action.payload };
    case 'SET_LOADING_CONVERSATION':
      return { ...state, isLoadingConversation: action.payload };
    case 'SET_LIST_ERROR':
      return { ...state, listError: action.payload };
    case 'SET_CONVERSATION_ERROR':
      return { ...state, conversationError: action.payload };
    default:
      return state;
  }
}

// --- Context ---

export interface ConversationContextValue {
  conversations: ConversationMetadata[];
  activeConversationId: string | null;
  isLoadingList: boolean;
  isLoadingConversation: boolean;
  listError: string | null;
  conversationError: string | null;
  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  switchConversation: (id: string) => Promise<Message[]>;
  renameConversation: (id: string, name: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<string | null>;
  saveMessages: (messages: Message[]) => Promise<void>;
}

const ConversationContext = createContext<ConversationContextValue | undefined>(undefined);

// --- Provider ---

export function ConversationProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(conversationReducer, initialState);

  const loadConversations = useCallback(async () => {
    dispatch({ type: 'SET_LOADING_LIST', payload: true });
    dispatch({ type: 'SET_LIST_ERROR', payload: null });
    try {
      const token = await getAuthToken();
      const conversations = await listConversations(token);
      dispatch({ type: 'SET_CONVERSATIONS', payload: conversations });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load conversations';
      dispatch({ type: 'SET_LIST_ERROR', payload: message });
    } finally {
      dispatch({ type: 'SET_LOADING_LIST', payload: false });
    }
  }, []);

  const createConversationFn = useCallback(async (): Promise<string> => {
    try {
      const token = await getAuthToken();
      const created = await apiCreateConversation(token);
      const metadata: ConversationMetadata = {
        conversationId: created.conversationId,
        conversationName: created.conversationName,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      };
      dispatch({ type: 'ADD_CONVERSATION', payload: metadata });
      dispatch({ type: 'SET_ACTIVE', payload: created.conversationId });
      return created.conversationId;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to create conversation';
      dispatch({ type: 'SET_CONVERSATION_ERROR', payload: message });
      throw error;
    }
  }, []);

  const switchConversation = useCallback(async (id: string): Promise<Message[]> => {
    dispatch({ type: 'SET_LOADING_CONVERSATION', payload: true });
    dispatch({ type: 'SET_CONVERSATION_ERROR', payload: null });
    try {
      const token = await getAuthToken();
      const conversation = await getConversation(token, id);
      dispatch({ type: 'SET_ACTIVE', payload: id });
      return conversation.messages;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load conversation';
      dispatch({ type: 'SET_CONVERSATION_ERROR', payload: message });
      throw error;
    } finally {
      dispatch({ type: 'SET_LOADING_CONVERSATION', payload: false });
    }
  }, []);

  const renameConversation = useCallback(async (id: string, name: string): Promise<void> => {
    try {
      const token = await getAuthToken();
      await updateConversation(token, id, { conversationName: name });
      dispatch({ type: 'RENAME_CONVERSATION', payload: { id, name } });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to rename conversation';
      dispatch({ type: 'SET_CONVERSATION_ERROR', payload: message });
      throw error;
    }
  }, []);

  const deleteConversationFn = useCallback(async (id: string): Promise<string | null> => {
    try {
      const token = await getAuthToken();
      await apiDeleteConversation(token, id);
      dispatch({ type: 'REMOVE_CONVERSATION', payload: id });

      // If deleted conversation was active, create a new one
      if (state.activeConversationId === id) {
        const newToken = await getAuthToken();
        const created = await apiCreateConversation(newToken);
        const metadata: ConversationMetadata = {
          conversationId: created.conversationId,
          conversationName: created.conversationName,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        };
        dispatch({ type: 'ADD_CONVERSATION', payload: metadata });
        dispatch({ type: 'SET_ACTIVE', payload: created.conversationId });
        // Return the replacement id so the caller can resync the chat view
        // (clear stale messages + retarget the chat session). Without this the
        // UI keeps showing the deleted conversation's messages and the next
        // send targets a stale id (same desync class as issue #19).
        return created.conversationId;
      }
      // A non-active conversation was deleted; the current view is unaffected.
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to delete conversation';
      dispatch({ type: 'SET_CONVERSATION_ERROR', payload: message });
      throw error;
    }
  }, [state.activeConversationId]);

  const saveMessages = useCallback(async (messages: Message[]): Promise<void> => {
    if (!state.activeConversationId) return;

    const attemptSave = async (): Promise<void> => {
      const token = await getAuthToken();
      await appendMessages(token, state.activeConversationId!, messages);
    };

    try {
      await attemptSave();
    } catch {
      // Retry once after 2-second delay
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await attemptSave();
      } catch (retryError: unknown) {
        const message = retryError instanceof Error
          ? retryError.message
          : 'Failed to save messages';
        dispatch({ type: 'SET_CONVERSATION_ERROR', payload: message });
      }
    }
  }, [state.activeConversationId]);

  const value: ConversationContextValue = {
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    isLoadingList: state.isLoadingList,
    isLoadingConversation: state.isLoadingConversation,
    listError: state.listError,
    conversationError: state.conversationError,
    loadConversations,
    createConversation: createConversationFn,
    switchConversation,
    renameConversation,
    deleteConversation: deleteConversationFn,
    saveMessages,
  };

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

// --- Hook ---

export function useConversationContext(): ConversationContextValue {
  const context = useContext(ConversationContext);
  if (context === undefined) {
    throw new Error('useConversationContext must be used within a ConversationProvider');
  }
  return context;
}
