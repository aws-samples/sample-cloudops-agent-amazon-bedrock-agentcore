import { v4 as uuidv4 } from 'uuid';
import { ChatState, ChatAction, Message } from '@/types';

export const initialChatState: ChatState = {
  messages: [],
  isLoading: false,
  progressMessage: null,
  error: null,
  saveError: null,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_LOADING':
      return {
        ...state,
        isLoading: action.payload,
        ...(action.payload === false && { progressMessage: null }),
      };

    case 'SET_PROGRESS':
      return {
        ...state,
        progressMessage: action.payload,
      };

    case 'SET_ERROR':
      return {
        ...state,
        isLoading: false,
        progressMessage: null,
        error: action.payload,
      };

    case 'SET_SAVE_ERROR':
      return {
        ...state,
        saveError: action.payload,
      };

    case 'RETRY_MESSAGE': {
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: action.payload.originalPrompt,
        timestamp: Date.now(),
        status: 'sent',
      };
      return {
        ...state,
        messages: [...state.messages, userMessage],
        isLoading: true,
        progressMessage: null,
        error: null,
        saveError: null,
      };
    }

    case 'UPSERT_MESSAGE': {
      const exists = state.messages.some(message => message.id === action.payload.id);
      return {
        ...state,
        messages: exists
          ? state.messages.map(message => message.id === action.payload.id ? action.payload : message)
          : [...state.messages, action.payload],
        isLoading: action.payload.status === 'streaming',
      };
    }

    case 'SET_MESSAGES':
      return {
        ...state,
        messages: action.payload,
        isLoading: false,
        progressMessage: null,
        error: null,
        saveError: null,
      };

    default:
      return state;
  }
}
