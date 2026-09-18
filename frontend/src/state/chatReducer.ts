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
    case 'SEND_MESSAGE': {
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: action.payload.content,
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

    case 'RECEIVE_MESSAGE': {
      const agentMessage: Message = {
        id: uuidv4(),
        role: 'agent',
        content: action.payload.content,
        timestamp: Date.now(),
        status: 'delivered',
      };
      return {
        ...state,
        messages: [...state.messages, agentMessage],
        isLoading: false,
        progressMessage: null,
      };
    }

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

    case 'CLEAR_MESSAGES':
      return {
        ...initialChatState,
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
