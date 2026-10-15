import { useCallback, useEffect, useRef, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Cloud, LoaderCircle } from 'lucide-react';
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ChatProvider, useChatContext } from '@/state/ChatContext';
import { ConversationProvider, useConversationContext } from '@/state/ConversationContext';
import { getAppConfig, getAgentName, loadRuntimeConfig } from '@/services/config';
import { ChatLayout } from '@/components/ChatLayout/ChatLayout';
import { ConfigEditor } from '@/components/ConfigEditor/ConfigEditor';
import type { AgentCredentials, AppConfig } from '@/types';

function configureAmplify(config: AppConfig) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.cognito.userPoolId,
        userPoolClientId: config.cognito.userPoolClientId,
        identityPoolId: config.cognito.identityPoolId,
      },
    },
  });
}

/** Minimal full-screen notice used for the loading and deployment-error states. */
function CenteredNotice({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <Cloud className="text-muted-foreground size-7" strokeWidth={1.5} />
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      {body ? <p className="text-muted-foreground max-w-lg text-sm leading-6">{body}</p> : <LoaderCircle className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none" />}
    </div>
  );
}

function App() {
  // Onboarding is login-first when the deployment baked app-config.json into the
  // bundle (issue #23). We resolve configuration once at startup; only the
  // absence of any deployment config falls back to the local setup form.
  const [status, setStatus] = useState<'loading' | 'ready' | 'needs-setup' | 'deploy-error'>('loading');
  const [deployError, setDeployError] = useState<string>('');
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await loadRuntimeConfig();
      if (cancelled) return;
      if (result.status === 'ready' && result.config) {
        configureAmplify(result.config);
        setStatus('ready');
      } else if (result.status === 'deploy-error') {
        setDeployError(result.error || 'The deployment configuration is invalid.');
        setStatus('deploy-error');
      } else {
        setStatus('needs-setup');
        setShowConfig(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') {
    return <CenteredNotice title="Loading…" />;
  }

  // Deployment config is present but broken: this is for the deployer to fix,
  // not something an end user should be asked to repair in a setup form.
  if (status === 'deploy-error') {
    return <CenteredNotice title="Configuration error" body={deployError} />;
  }

  // Setup form: the local-development / custom-backend path (no deployment
  // config present), or when a configured user explicitly opens Settings.
  if (showConfig) {
    return <ConfigEditor onClose={status === 'ready' ? () => setShowConfig(false) : undefined} />;
  }

  return (
    <div className="auth-wrapper">
      <Authenticator
        hideSignUp={true}
        components={{
          Header() {
            return (
              <div className="cloudops-login-heading">
                <div className="cloudops-login-mark"><Cloud size={24} strokeWidth={1.5} /></div>
                <h1>Welcome to CloudOps</h1>
                <p>Sign in to investigate your AWS environment.</p>
              </div>
            );
          },
        }}
      >
        {({ user, signOut }) => (
          <ConversationProvider>
            <ConversationChatProvider>
              <ChatLayoutWired
                user={user}
                signOut={signOut}
                onOpenSettings={() => setShowConfig(true)}
              />
            </ConversationChatProvider>
          </ConversationProvider>
        )}
      </Authenticator>
    </div>
  );
}

function ConversationChatProvider({ children }: { children: React.ReactNode }) {
  const { receiveSavedConversation } = useConversationContext();
  return <ChatProvider onConversationSaved={receiveSavedConversation}>{children}</ChatProvider>;
}

interface ChatLayoutWiredProps {
  user: any;
  signOut: (() => void) | undefined;
  onOpenSettings: () => void;
}

function ChatLayoutWired({ user, signOut, onOpenSettings }: ChatLayoutWiredProps) {
  const [sendError, setSendError] = useState<{ message: string; originalPrompt: string } | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [canUseOperations, setCanUseOperations] = useState(false);
  const preparing = useRef(false);
  const {
    sessionId,
    messages,
    isLoading,
    progressMessage,
    error,
    saveError,
    sendMessage,
    retryMessage,
    cancelRequest,
    setMessages,
    setSessionId,
    forgetConversation,
    dismissSaveError,
  } = useChatContext();

  const {
    conversations,
    activeConversationId,
    isLoadingList,
    isLoadingConversation,
    conversationError,
    listError,
    loadConversations,
    createConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
  } = useConversationContext();

  // Suggestions are a convenience, not authorization. Unknown roles stay non-admin;
  // the verified token and Gateway policy still govern every actual tool call.
  useEffect(() => {
    let cancelled = false;
    fetchAuthSession().then(session => {
      const token = session.tokens?.accessToken ?? session.tokens?.idToken;
      if (!cancelled) setCanUseOperations(token?.payload?.role === 'admin');
    }).catch(() => { if (!cancelled) setCanUseOperations(false); });
    return () => { cancelled = true; };
  }, [user?.username]);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Derive user name from Amplify Auth user attributes or default to "User"
  const userName =
    user?.signInDetails?.loginId?.split('@')[0] ||
    user?.username ||
    'User';

  // Get agent name from config
  let agentName = 'CloudOps Agent';
  try {
    agentName = getAgentName(getAppConfig());
  } catch {
    // Use default if config not available
  }

  // Get credentials from Amplify Auth session for API calls
  const getCredentials = useCallback(async (): Promise<AgentCredentials> => {
    const session = await fetchAuthSession();
    const credentials = session.credentials;
    if (!credentials) {
      throw new Error('Unable to retrieve authentication credentials');
    }
    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    };
  }, []);

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (preparing.current) return;
      preparing.current = true;
      setIsPreparing(true);
      setSendError(null);
      try {
        const credentials = await getCredentials();
        // Preserve #19: create the persisted conversation before its first send.
        // If history is unavailable, allow an answer and surface the save failure.
        if (!activeConversationId) {
          try {
            const newId = await createConversation();
            setSessionId(newId);
          } catch {
            // ConversationContext surfaces the creation error.
          }
        }
        // sendMessage captures its target synchronously and owns error handling.
        void sendMessage(text, credentials);
      } catch {
        setSendError({ message: 'Sign in again to send your message, then retry.', originalPrompt: text });
      } finally {
        preparing.current = false;
        setIsPreparing(false);
      }
    },
    [getCredentials, sendMessage, activeConversationId, createConversation, setSessionId]
  );

  const handleRetry = useCallback(async () => {
    if (sendError) {
      await handleSendMessage(sendError.originalPrompt);
      return;
    }
    try {
      const credentials = await getCredentials();
      retryMessage(credentials);
    } catch {
      setSendError({ message: 'Sign in again to send your message, then retry.', originalPrompt: error?.originalPrompt ?? '' });
    }
  }, [getCredentials, retryMessage, sendError, handleSendMessage, error]);

  const handleNewConversation = useCallback(async () => {
    if (preparing.current) return;
    setSendError(null);
    try {
      const newId = await createConversation();
      // Don't call clearMessages() — that would cancel in-flight requests for the current conversation
      // Just clear the UI and switch session
      setSessionId(newId);
      setMessages([]);
    } catch {
      // ConversationContext handles the error state
    }
  }, [createConversation, setMessages, setSessionId]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      if (preparing.current || id === activeConversationId) return;
      try {
        const loadedMessages = await switchConversation(id);
        setSendError(null);
        setSessionId(id);
        setMessages(loadedMessages);
      } catch {
        // ConversationContext handles the error state
      }
    },
    [activeConversationId, switchConversation, setMessages, setSessionId]
  );

  const handleRetryLoad = useCallback(() => {
    loadConversations();
  }, [loadConversations]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      // deleteConversation returns the replacement conversation id when the
      // ACTIVE conversation was deleted (and a fresh one created). In that case
      // resync the chat view — clear the deleted conversation's messages and
      // retarget the chat session — so the UI does not keep showing stale
      // messages or send the next message to a deleted id.
      const newActiveId = await deleteConversation(id);
      forgetConversation(id);
      if (newActiveId) {
        setSessionId(newActiveId);
        setMessages([]);
      }
    },
    [deleteConversation, forgetConversation, setMessages, setSessionId]
  );

  return (
    <ChatLayout
      sessionId={sessionId}
      canUseOperations={canUseOperations}
      messages={messages}
      isLoading={isLoading}
      progressMessage={progressMessage}
      isPreparing={isPreparing || isLoadingConversation}
      error={sendError ?? error}
      conversationError={conversationError}
      saveError={saveError}
      onDismissSaveError={dismissSaveError}
      agentName={agentName}
      userName={userName}
      onSendMessage={handleSendMessage}
      onRetry={handleRetry}
      onClearMessages={handleNewConversation}
      onCancelRequest={cancelRequest}
      onOpenSettings={onOpenSettings}
      onLogout={signOut}
      conversations={conversations}
      activeConversationId={activeConversationId}
      isLoadingList={isLoadingList}
      listError={listError}
      onSelectConversation={handleSelectConversation}
      onNewConversation={handleNewConversation}
      onRenameConversation={renameConversation}
      onDeleteConversation={handleDeleteConversation}
      onRetryLoad={handleRetryLoad}
    />
  );
}

export default App;
