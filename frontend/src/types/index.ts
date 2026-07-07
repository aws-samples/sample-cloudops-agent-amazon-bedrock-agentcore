// Message types
export interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
  status: 'sent' | 'delivered' | 'error';
  errorMessage?: string;
}

// Chat state
export interface ChatState {
  messages: Message[];
  isLoading: boolean;
  progressMessage: string | null;
  error: { message: string; originalPrompt: string } | null;
}

// Chat context actions
export type ChatAction =
  | { type: 'SEND_MESSAGE'; payload: { content: string } }
  | { type: 'RECEIVE_MESSAGE'; payload: { content: string } }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_PROGRESS'; payload: string | null }
  | { type: 'SET_ERROR'; payload: { message: string; originalPrompt: string } | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'RETRY_MESSAGE'; payload: { originalPrompt: string } }
  | { type: 'SET_MESSAGES'; payload: Message[] };

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

// Component prop types
export interface MessageInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
  onCancel?: () => void;
}

export interface TypingIndicatorProps {
  progressMessage?: string | null;
}

export interface ErrorMessageProps {
  error: string;
  onRetry: () => void;
  onCancel: () => void;
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
  | { type: 'SET_LOADING_LIST'; payload: boolean }
  | { type: 'SET_LOADING_CONVERSATION'; payload: boolean }
  | { type: 'SET_LIST_ERROR'; payload: string | null }
  | { type: 'SET_CONVERSATION_ERROR'; payload: string | null };

export interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  conversations?: ConversationMetadata[];
  activeConversationId?: string | null;
  isLoadingList?: boolean;
  listError?: string | null;
  onSelectConversation?: (id: string) => void;
  onNewConversation?: () => void;
  onRenameConversation?: (id: string, name: string) => void;
  onDeleteConversation?: (id: string) => void;
  onRetryLoad?: () => void;
}

export interface ChatHeaderProps {
  onNewConversation: () => void;
  onToggleSidebar: () => void;
  onOpenSettings?: () => void;
  onLogout?: () => void;
  agentName: string;
  userName: string;
}

export interface ScrollToBottomProps {
  onClick: () => void;
  visible: boolean;
}
