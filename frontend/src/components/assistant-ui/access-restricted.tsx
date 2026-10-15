import { LockKeyhole } from 'lucide-react';
import { RawToolOutput } from '@/components/tool-ui/RawToolOutput';

export function AccessRestricted({ output, unavailable = false }: { output?: unknown; unavailable?: boolean }) {
  return (
    <section aria-label="Access restricted" className="my-3 flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"><LockKeyhole className="size-4" /></div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">Access restricted</h3>
        <p className="text-muted-foreground mt-1 text-sm">{unavailable
          ? 'This capability is not available in your current workspace. No restricted tool was invoked.'
          : 'Your current access does not allow this action. No restricted data was returned.'}</p>
        <p className="text-muted-foreground mt-2 text-xs">Ask an administrator if you need access. You can continue with billing and pricing questions.</p>
        {output !== undefined && <RawToolOutput value={output} />}
      </div>
    </section>
  );
}
