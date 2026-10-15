import type { Presentation } from '@/components/tool-ui/schema';
import type { ToolOutput } from '@/services/toolOutput';

export interface ToolPart {
  type: 'tool';
  toolCallId: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'blocked' | 'unavailable';
  presentation?: Presentation;
  output?: ToolOutput;
}

export type MessagePart = { type: 'text'; text: string } | ToolPart;

// Message types
export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
  status: 'sent' | 'delivered' | 'error' | 'streaming' | 'interrupted' | 'restricted';
  errorMessage?: string;
  partsVersion?: 1;
  parts?: MessagePart[];
}

// Chat state
export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  progressMessage: string | null;
  error: { message: string; originalPrompt: string } | null;
  // Non-blocking notice shown when persisting a message to conversation history
  // fails. Distinct from `error` (which is a hard send failure with retry), so
  // a save failure is surfaced without implying the exchange was stored
  // (issue #19).
  saveError: string | null;
}

// Chat context actions
export type ChatAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_PROGRESS'; payload: string | null }
  | { type: 'SET_ERROR'; payload: { message: string; originalPrompt: string } | null }
  | { type: 'SET_SAVE_ERROR'; payload: string | null }
  | { type: 'RETRY_MESSAGE'; payload: { originalPrompt: string } }
  | { type: 'SET_MESSAGES'; payload: Message[] }
  | { type: 'UPSERT_MESSAGE'; payload: Message };

// App config — read from localStorage("appConfig")
export interface AppConfig {
  cognito: {
    userPoolId: string;
    userPoolClientId: string;
    identityPoolId: string;
    region: string;
  };
  agentcore: {
    enabled: boolean;
    region: string;
    agentArn: string;
    agentName?: string;
  };
  bedrock?: {
    region: string;
    agentId: string;
    agentAliasId: string;
    agentName?: string;
  };
  strands?: {
    enabled: boolean;
    region: string;
    lambdaArn: string;
    agentName?: string;
  };
  conversationApi?: {
    endpoint: string; // API Gateway URL e.g. "https://xxxx.execute-api.us-east-1.amazonaws.com/prod"
  };
}

// Agent credentials passed from Amplify Auth (Cognito)
export interface AgentCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// Conversation metadata (returned from list endpoint, no messages)
export interface ConversationMetadata {
  conversationId: string;
  conversationName: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// Full conversation with messages (returned from get endpoint)
export interface ConversationFull extends ConversationMetadata {
  messages: Message[];
}

// Body for updating a conversation
export interface ConversationUpdateBody {
  conversationName?: string;
  messages?: Message[]; // Messages to append
}

// Conversation state for the context
export interface ConversationState {
  conversations: ConversationMetadata[];
  activeConversationId: string | null;
  isLoadingList: boolean;
  isLoadingConversation: boolean;
  listError: string | null;
  conversationError: string | null;
}

// Conversation context actions
export type ConversationAction =
  | { type: 'SET_CONVERSATIONS'; payload: ConversationMetadata[] }
  | { type: 'SET_ACTIVE'; payload: string | null }
  | { type: 'ADD_CONVERSATION'; payload: ConversationMetadata }
  | { type: 'REMOVE_CONVERSATION'; payload: string }
  | { type: 'RENAME_CONVERSATION'; payload: { id: string; name: string } }
  | { type: 'UPDATE_METADATA'; payload: ConversationMetadata }
  | { type: 'SET_LOADING_LIST'; payload: boolean }
  | { type: 'SET_LOADING_CONVERSATION'; payload: boolean }
  | { type: 'SET_LIST_ERROR'; payload: string | null }
  | { type: 'SET_CONVERSATION_ERROR'; payload: string | null };
