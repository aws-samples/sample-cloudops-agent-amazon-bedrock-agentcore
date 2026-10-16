import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseToolOutput } from '@/services/toolOutput';

export function RawToolOutput({ value }: { value: unknown }) {
  const output = parseToolOutput(value);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!output) return null;
  const formatted = JSON.stringify(JSON.parse(output.json), null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      setCopyError(false);
    } catch { setCopyError(true); }
  };
  return (
    <details className="mt-3 rounded-lg border bg-muted/30">
      <summary className="text-muted-foreground px-3 py-2 text-xs font-medium">Raw JSON</summary>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        <div className="text-muted-foreground flex flex-wrap gap-2 text-[11px]">
          {output.redacted && <span>Sensitive fields redacted</span>}
          {output.truncated && <span>Output truncated to fit the trace limit</span>}
          {!output.redacted && !output.truncated && <span>Tool response</span>}
        </div>
        <Button variant="ghost" size="sm" aria-label="Copy tool output" onClick={() => void copy()} className="h-7 gap-1.5 px-2 text-xs">{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      {copyError && <p role="status" className="text-destructive px-3 pb-2 text-xs">Could not copy. Select the output below to copy it manually.</p>}
      <pre role="region" aria-label="Raw tool output" tabIndex={0} className="max-h-80 overflow-auto border-t p-3 font-mono text-[11px] leading-5"><code>{formatted}</code></pre>
    </details>
  );
}
