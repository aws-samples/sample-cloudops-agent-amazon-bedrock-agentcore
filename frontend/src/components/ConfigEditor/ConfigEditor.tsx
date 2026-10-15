import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Cloud, KeyRound, Server, Database, Info } from 'lucide-react';
import type { AppConfig } from '@/types';
import { isValidHttpUrl } from '@/services/config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DEFAULT_REGION = (import.meta.env.VITE_AWS_REGION as string | undefined) || '';

function existingConfig(): AppConfig | null {
  try { return JSON.parse(localStorage.getItem('appConfig') || 'null'); }
  catch { return null; }
}

export function ConfigEditor({ onClose }: { onClose?: () => void }) {
  const existing = existingConfig();
  const [values, setValues] = useState({
    userPoolId: existing?.cognito?.userPoolId ?? '',
    userPoolClientId: existing?.cognito?.userPoolClientId ?? '',
    identityPoolId: existing?.cognito?.identityPoolId ?? '',
    cognitoRegion: existing?.cognito?.region ?? DEFAULT_REGION,
    agentName: existing?.agentcore?.agentName ?? 'CloudOps Agent',
    agentArn: existing?.agentcore?.agentArn ?? '',
    agentRegion: existing?.agentcore?.region ?? DEFAULT_REGION,
    historyEndpoint: existing?.conversationApi?.endpoint ?? '',
  });
  const [error, setError] = useState('');
  const local = import.meta.env.DEV && import.meta.env.VITE_LOCAL_API === '1';
  const field = (name: keyof typeof values, label: string, placeholder: string, required = true) => (
    <label className="flex flex-col gap-2 text-xs font-medium">{label}<Input aria-label={label} required={required} value={values[name]} placeholder={placeholder} onChange={event => setValues(current => ({ ...current, [name]: event.target.value }))} className="h-10 border-input bg-background font-normal" /></label>
  );
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!values.userPoolId.trim() || !values.userPoolClientId.trim() || !values.identityPoolId.trim() || !values.cognitoRegion.trim()) {
      setError('All Cognito fields are required.'); return;
    }
    if (!isValidHttpUrl(values.historyEndpoint)) { setError('Enter a valid http(s) conversation history endpoint.'); return; }
    if (!values.agentArn.trim()) { setError('An AgentCore runtime ARN is required.'); return; }
    const config: AppConfig = {
      cognito: { userPoolId: values.userPoolId.trim(), userPoolClientId: values.userPoolClientId.trim(), identityPoolId: values.identityPoolId.trim(), region: values.cognitoRegion.trim() },
      agentcore: { enabled: true, agentName: values.agentName.trim(), agentArn: values.agentArn.trim(), region: values.agentRegion.trim() || values.cognitoRegion.trim() },
      conversationApi: { endpoint: values.historyEndpoint.trim() },
    };
    localStorage.setItem('appConfig', JSON.stringify(config));
    window.location.reload();
  };
  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <header className="flex h-16 items-center justify-between border-b px-5 md:px-8"><div className="flex items-center gap-2.5 text-sm font-semibold"><Cloud className="size-5" />CloudOps Agent</div>{onClose && <Button variant="ghost" size="sm" onClick={onClose} aria-label="Back to workspace"><ArrowLeft className="size-4" />Back to workspace</Button>}</header>
      <main className="mx-auto max-w-3xl px-5 py-10 md:py-14">
        <h1 className="text-2xl font-medium tracking-tight">{onClose ? 'Workspace settings' : 'Connect your workspace'}</h1>
        <p className="text-muted-foreground mt-2 max-w-xl text-sm">Connect the identity, runtime, and history services for your CloudOps workspace.</p>
        <div className="text-muted-foreground my-7 flex items-start gap-3 rounded-xl border bg-muted/40 p-4 text-xs leading-5"><Info className="mt-0.5 size-4 shrink-0" /><p>{local ? 'Local development uses your Cognito identity and live AWS services. Agent execution and conversation history are served locally; history resets when the backend restarts.' : 'Deployment-supplied configuration takes precedence on reload. Change your deployment configuration to update a hosted workspace. These fields contain connection IDs, not passwords or secret keys.'}</p></div>
        <form onSubmit={save} className="space-y-8">
          <section className="border-b pb-8"><h2 className="mb-5 flex items-center gap-2 text-sm font-semibold"><KeyRound className="text-muted-foreground size-4" />Identity</h2><div className="grid gap-5 md:grid-cols-2">{field('userPoolId', 'User Pool ID', 'Region_pool')}{field('userPoolClientId', 'User Pool Client ID', 'Cognito app client')}{field('identityPoolId', 'Identity Pool ID', 'Region:identity-pool')}{field('cognitoRegion', 'Cognito Region', 'AWS region')}</div></section>
          <section className="border-b pb-8"><h2 className="mb-5 flex items-center gap-2 text-sm font-semibold"><Server className="text-muted-foreground size-4" />Agent runtime</h2><div className="grid gap-5 md:grid-cols-2">{field('agentName', 'Agent Name', 'CloudOps Agent', false)}{field('agentRegion', 'AgentCore Region', 'AWS region', false)}<div className="md:col-span-2">{field('agentArn', 'AgentCore Runtime ARN', 'arn:aws:bedrock-agentcore:…')}</div></div></section>
          <section><h2 className="mb-5 flex items-center gap-2 text-sm font-semibold"><Database className="text-muted-foreground size-4" />Conversation history</h2>{field('historyEndpoint', 'API Endpoint URL', 'https://…execute-api…/prod')}<p className="text-muted-foreground mt-2 text-xs">Use the ConversationApiUrl output from your deployed history stack.</p></section>
          {error && <p role="alert" className="text-destructive rounded-lg border border-destructive/25 p-3 text-sm">{error}</p>}
          <div className="flex items-center gap-3 border-t pt-6"><Button type="submit"><Check className="size-4" />Save configuration</Button>{onClose && <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>}</div>
        </form>
      </main>
    </div>
  );
}
