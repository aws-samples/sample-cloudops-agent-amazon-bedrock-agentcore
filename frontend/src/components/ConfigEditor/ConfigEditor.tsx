import { useState } from 'react';
import type { AppConfig } from '@/types';
import styles from './ConfigEditor.module.css';

// Default region for the config form. Read from the build-time env var
// (VITE_AWS_REGION) when provided; otherwise left blank so the user picks it.
// No region is hard-coded.
const DEFAULT_REGION = (import.meta.env.VITE_AWS_REGION as string | undefined) || '';

function loadExistingConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem('appConfig');
    if (!raw) return null;
    return JSON.parse(raw) as AppConfig;
  } catch {
    return null;
  }
}

export function ConfigEditor({ onClose }: { onClose?: () => void }) {
  const existing = loadExistingConfig();

  // Cognito fields
  const [userPoolId, setUserPoolId] = useState(existing?.cognito?.userPoolId || '');
  const [userPoolClientId, setUserPoolClientId] = useState(existing?.cognito?.userPoolClientId || '');
  const [identityPoolId, setIdentityPoolId] = useState(existing?.cognito?.identityPoolId || '');
  const [cognitoRegion, setCognitoRegion] = useState(existing?.cognito?.region || DEFAULT_REGION);

  // AgentCore fields
  const [acAgentName, setAcAgentName] = useState(existing?.agentcore?.agentName || 'CloudOps Agent');
  const [acAgentArn, setAcAgentArn] = useState(existing?.agentcore?.agentArn || '');
  const [acRegion, setAcRegion] = useState(existing?.agentcore?.region || DEFAULT_REGION);

  // Conversation API
  const [conversationApiEndpoint, setConversationApiEndpoint] = useState(existing?.conversationApi?.endpoint || '');

  const [error, setError] = useState('');

  function handleSave() {
    // Validate required Cognito fields
    if (!userPoolId.trim() || !userPoolClientId.trim() || !identityPoolId.trim() || !cognitoRegion.trim()) {
      setError('All Cognito fields are required.');
      return;
    }

    const config: AppConfig = {
      cognito: {
        userPoolId: userPoolId.trim(),
        userPoolClientId: userPoolClientId.trim(),
        identityPoolId: identityPoolId.trim(),
        region: cognitoRegion.trim(),
      },
      agentcore: {
        enabled: true,
        region: acRegion.trim() || cognitoRegion.trim(),
        agentArn: acAgentArn.trim(),
        agentName: acAgentName.trim() || undefined,
      },
    };

    if (conversationApiEndpoint.trim()) {
      config.conversationApi = {
        endpoint: conversationApiEndpoint.trim(),
      };
    }

    localStorage.setItem('appConfig', JSON.stringify(config));
    window.location.reload();
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        {onClose && (
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close configuration"
          >
            ✕
          </button>
        )}
        <h1 className={styles.title}>Welcome</h1>
        <p className={styles.description}>
          Agentic AI powered by Amazon Bedrock AgentCore
        </p>

        {/* Two-column layout: Cognito left, AgentCore right */}
        <div className={styles.twoColumns}>
          {/* Left: Cognito Section */}
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Amazon Cognito</h2>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>
                User Pool ID *
                <input
                  className={styles.input}
                  type="text"
                  placeholder="us-east-1_xxxxx"
                  value={userPoolId}
                  onChange={(e) => setUserPoolId(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                User Pool Client ID *
                <input
                  className={styles.input}
                  type="text"
                  placeholder="xxxxxxxxxx"
                  value={userPoolClientId}
                  onChange={(e) => setUserPoolClientId(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Identity Pool ID *
                <input
                  className={styles.input}
                  type="text"
                  placeholder="us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={identityPoolId}
                  onChange={(e) => setIdentityPoolId(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Region *
                <input
                  className={styles.input}
                  type="text"
                  placeholder="us-east-1"
                  value={cognitoRegion}
                  onChange={(e) => setCognitoRegion(e.target.value)}
                />
              </label>
            </div>
          </div>

          {/* Right: AgentCore Section */}
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>AgentCore</h2>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>
                Agent Name
                <input
                  className={styles.input}
                  type="text"
                  placeholder="CloudOps Agent"
                  value={acAgentName}
                  onChange={(e) => setAcAgentName(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                AgentCore Runtime ARN
                <input
                  className={styles.input}
                  type="text"
                  placeholder="arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/agent-xyz"
                  value={acAgentArn}
                  onChange={(e) => setAcAgentArn(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Region
                <input
                  className={styles.input}
                  type="text"
                  placeholder="us-east-1"
                  value={acRegion}
                  onChange={(e) => setAcRegion(e.target.value)}
                />
              </label>
            </div>
          </div>
        </div>

        {/* Conversation History API — full width below */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Conversation History API</h2>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              API Endpoint URL
              <input
                className={styles.input}
                type="text"
                placeholder="https://xxxx.execute-api.us-east-1.amazonaws.com/prod"
                value={conversationApiEndpoint}
                onChange={(e) => setConversationApiEndpoint(e.target.value)}
              />
            </label>
          </div>
        </div>

        {error && <p className={styles.errorText}>{error}</p>}

        <div className={styles.buttonGroup}>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={handleSave}
          >
            Save
          </button>
          {onClose && (
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onClose}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
