import { useCallback, useEffect, useState, useRef } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Amplify } from 'aws-amplify';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ChatProvider, useChatContext } from '@/state/ChatContext';
import {
  ConversationProvider,
  useConversationContext,
} from '@/state/ConversationContext';
import {
  getAppConfig,
  getAgentName,
  loadRuntimeConfig,
} from '@/services/config';
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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '24px',
        textAlign: 'center',
        color: '#1e293b',
      }}
    >
      <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>{title}</h2>
      {body && (
        <p
          style={{
            fontSize: '14px',
            color: '#64748b',
            margin: 0,
            maxWidth: '520px',
          }}
        >
          {body}
        </p>
      )}
    </div>
  );
}

function App() {
  // Onboarding is login-first when the deployment baked app-config.json into the
  // bundle (issue #23). We resolve configuration once at startup; only the
  // absence of any deployment config falls back to the local setup form.
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'needs-setup' | 'deploy-error'
  >('loading');
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
        setDeployError(
          result.error || 'The deployment configuration is invalid.',
        );
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
    return (
      <ConfigEditor
        onClose={status === 'ready' ? () => setShowConfig(false) : undefined}
      />
    );
  }

  return (
    <div className="auth-wrapper">
      <Authenticator
        hideSignUp={true}
        components={{
          Header() {
            return (
              <div
                style={{
                  textAlign: 'center',
                  padding: '24px 24px 0',
                }}
              >
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 12px',
                    fontSize: '20px',
                    color: '#fff',
                  }}
                >
                  ✦
                </div>
                <h2
                  style={{
                    fontSize: '20px',
                    fontWeight: 700,
                    color: '#1e293b',
                    margin: '0 0 4px',
                  }}
                >
                  CloudOps Agent
                </h2>
                <p
                  style={{
                    fontSize: '14px',
                    color: '#64748b',
                    margin: 0,
                  }}
                >
                  Agentic AI powered by Amazon Bedrock AgentCore
                </p>
              </div>
            );
          },
        }}
      >
        {({ user, signOut }) => (
          <ConversationProvider>
            <ChatProvider>
              <ChatLayoutWired
                user={user}
                signOut={signOut}
                onOpenSettings={() => setShowConfig(true)}
              />
            </ChatProvider>
          </ConversationProvider>
        )}
      </Authenticator>
    </div>
  );
}

interface ChatLayoutWiredProps {
  user: any;
  signOut: (() => void) | undefined;
  onOpenSettings: () => void;
}

export function ChatLayoutWired({
  user,
  signOut,
  onOpenSettings,
}: ChatLayoutWiredProps) {
  const {
    messages,
    isLoading,
    error,
    saveError,
    sendMessage,
    retryMessage,
    cancelRequest,
    setMessages,
    setSessionId,
    dismissSaveError,
    discardConversation,
    progressMessage: savedProgress,
  } = useChatContext();

  const {
    conversations,
    activeConversationId,
    isLoadingList,
    listError,
    loadConversations,
    createConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
  } = useConversationContext();

  const [sendError, setSendError] = useState<{
    message: string;
    originalPrompt: string;
  } | null>(null);
  const progressMessage =
    savedProgress ||
    (isLoading
      ? messages.some((m) => m.status === 'streaming')
        ? 'Receiving response…'
        : 'Waiting for the agent…'
      : null);
  const navigation = useRef(0);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Derive user name from Amplify Auth user attributes or default to "User"
  const userName =
    user?.signInDetails?.loginId?.split('@')[0] || user?.username || 'User';

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
      setSendError(null);
      const targetNavigation = navigation.current;
      try {
        const credentials = await getCredentials();
        if (navigation.current !== targetNavigation) return;
        // #19: Ensure a persisted conversation exists BEFORE sending. Without
        // this, the very first message is saved against the transient client
        // session id (e.g. "agentcore-session-…"), which the history API rejects
        // with HTTP 400 "Invalid conversationId format" — so the exchange is
        // silently lost on reload. Creating (or reusing) a real conversation
        // yields a UUID the API accepts, and aligns the AgentCore session id with
        // the conversation. If creation fails, we still let the user get an
        // answer; ChatContext then surfaces the save failure rather than
        // implying the exchange was stored.
        if (!activeConversationId) {
          try {
            const newId = await createConversation();
            if (navigation.current !== targetNavigation) return;
            setSessionId(newId);
          } catch {
            // ConversationContext surfaces the creation error via its own state.
          }
        }
        if (navigation.current === targetNavigation)
          await sendMessage(text, credentials);
      } catch {
        if (navigation.current === targetNavigation)
          setSendError({
            message: 'Unable to authenticate. Please sign in and try again.',
            originalPrompt: text,
          });
      }
    },
    [
      getCredentials,
      sendMessage,
      activeConversationId,
      createConversation,
      setSessionId,
    ],
  );

  const handleRetry = useCallback(async () => {
    if (sendError) {
      await handleSendMessage(sendError.originalPrompt);
      return;
    }
    const targetNavigation = navigation.current;
    try {
      const credentials = await getCredentials();
      if (navigation.current === targetNavigation) retryMessage(credentials);
    } catch {
      if (navigation.current === targetNavigation)
        setSendError({
          message: 'Unable to authenticate. Please sign in and try again.',
          originalPrompt: error?.originalPrompt || '',
        });
    }
  }, [getCredentials, retryMessage, sendError, handleSendMessage, error]);

  const handleNewConversation = useCallback(async () => {
    const targetNavigation = ++navigation.current;
    setSendError(null);
    try {
      const newId = await createConversation();
      if (navigation.current !== targetNavigation) return;
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
      if (id === activeConversationId) return;
      const targetNavigation = ++navigation.current;
      setSendError(null);
      try {
        const loadedMessages = await switchConversation(id);
        if (navigation.current !== targetNavigation) return;
        setSessionId(id);
        setMessages(loadedMessages);
      } catch {
        // ConversationContext handles the error state
      }
    },
    [activeConversationId, switchConversation, setMessages, setSessionId],
  );

  const handleRetryLoad = useCallback(() => {
    loadConversations();
  }, [loadConversations]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const targetNavigation =
        id === activeConversationId ? ++navigation.current : navigation.current;
      // deleteConversation returns the replacement conversation id when the
      // ACTIVE conversation was deleted (and a fresh one created). In that case
      // resync the chat view — clear the deleted conversation's messages and
      // retarget the chat session — so the UI does not keep showing stale
      // messages or send the next message to a deleted id.
      const newActiveId = await deleteConversation(id);
      discardConversation(id);
      if (newActiveId && navigation.current === targetNavigation) {
        setSessionId(newActiveId);
        setMessages([]);
      }
    },
    [
      deleteConversation,
      discardConversation,
      setMessages,
      setSessionId,
      activeConversationId,
    ],
  );

  return (
    <ChatLayout
      messages={messages}
      isLoading={isLoading}
      progressMessage={progressMessage}
      error={sendError || error}
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
