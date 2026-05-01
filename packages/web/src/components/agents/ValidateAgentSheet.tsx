import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { validateAgent, type AgentSource, type ValidateAgentResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ValidateAgentSheetProps {
  name: string;
  source: AgentSource;
  cwd: string | undefined;
  onClose: () => void;
}

export function ValidateAgentSheet({
  name,
  source,
  cwd,
  onClose,
}: ValidateAgentSheetProps): React.ReactElement {
  const [result, setResult] = useState<ValidateAgentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResult(null);
    setError(null);
    validateAgent(name, source, cwd)
      .then(r => {
        if (!cancelled) setResult(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [name, source, cwd]);

  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>Validate agent</SheetTitle>
          <SheetDescription>
            Smoke-runs <code className="font-mono">{name}</code> against the Claude Agent SDK and
            inspects the system.init event for active tools, MCP server connectivity, and skill
            loading.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 rounded-md border border-bridges-border-subtle bg-bridges-surface-subtle px-3 py-3 text-[12.5px] text-bridges-fg2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Running smoke query…
            </div>
          )}

          {error && (
            <Section icon="error" title="Validation failed to run">
              <div className="text-[12.5px] text-bridges-tint-danger-fg">{error}</div>
            </Section>
          )}

          {result && (
            <>
              <Section
                icon={result.ok ? 'ok' : 'error'}
                title={result.ok ? 'Smoke run succeeded' : 'Smoke run reported errors'}
              >
                {result.errors.length > 0 ? (
                  <ul className="space-y-1 text-[12.5px] text-bridges-tint-danger-fg">
                    {result.errors.map(e => (
                      <li key={e}>• {e}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-[12.5px] text-bridges-fg2">
                    No errors. {result.costUsd != null && `Cost: $${result.costUsd.toFixed(4)}.`}
                  </div>
                )}
              </Section>

              <Section icon="ok" title="Model">
                <div className="font-mono text-[12.5px] text-bridges-fg1">
                  {result.model ?? '(default)'}
                </div>
              </Section>

              <Section icon="ok" title={`Active tools (${result.activeTools.length})`}>
                <div className="flex flex-wrap gap-1">
                  {result.activeTools.length === 0 && (
                    <span className="text-[12.5px] text-bridges-fg3">None reported.</span>
                  )}
                  {result.activeTools.map(t => (
                    <span
                      key={t}
                      className="inline-flex items-center rounded bg-bridges-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-bridges-fg2"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </Section>

              <Section
                icon={
                  result.mcpServers.length === 0
                    ? 'ok'
                    : result.mcpServers.every(s => s.status === 'connected')
                      ? 'ok'
                      : 'warn'
                }
                title={`MCP servers (${result.mcpServers.length})`}
              >
                {result.mcpServers.length === 0 ? (
                  <div className="text-[12.5px] text-bridges-fg3">No MCP servers configured.</div>
                ) : (
                  <ul className="space-y-1 text-[12.5px]">
                    {result.mcpServers.map(s => (
                      <li
                        key={s.name}
                        className={cn(
                          'flex items-center justify-between',
                          s.status === 'connected'
                            ? 'text-bridges-tint-success-fg'
                            : 'text-bridges-tint-danger-fg'
                        )}
                      >
                        <span className="font-mono">{s.name}</span>
                        <span>{s.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section icon="ok" title={`Skills loaded (${result.skillsLoaded.length})`}>
                {result.skillsLoaded.length === 0 ? (
                  <div className="text-[12.5px] text-bridges-fg3">No skills loaded.</div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {result.skillsLoaded.map(s => (
                      <span
                        key={s}
                        className="inline-flex items-center rounded bg-bridges-tag-mint-bg px-1.5 py-0.5 font-mono text-[11px] text-bridges-tag-mint-fg"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </Section>

              {result.warnings.length > 0 && (
                <Section icon="warn" title="Warnings">
                  <ul className="space-y-1 text-[12.5px] text-bridges-tint-warning-fg">
                    {result.warnings.map(w => (
                      <li key={w}>• {w}</li>
                    ))}
                  </ul>
                </Section>
              )}

              {result.missingEnvVars.length > 0 && (
                <Section icon="warn" title="Missing environment variables">
                  <div className="flex flex-wrap gap-1">
                    {result.missingEnvVars.map(v => (
                      <code
                        key={v}
                        className="rounded bg-bridges-tint-warning-bg px-1.5 py-0.5 text-[11px] text-bridges-tint-warning-fg"
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                </Section>
              )}

              {result.sampleReply && (
                <Section icon="ok" title="Sample reply">
                  <pre className="max-h-32 overflow-y-auto rounded bg-bridges-surface-muted px-2.5 py-2 font-mono text-[11px] leading-snug text-bridges-fg2">
                    {result.sampleReply}
                  </pre>
                </Section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: 'ok' | 'warn' | 'error';
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const iconNode =
    icon === 'warn' ? (
      <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0', 'text-bridges-warning')} />
    ) : icon === 'error' ? (
      <XCircle className={cn('h-3.5 w-3.5 shrink-0', 'text-bridges-tint-danger-fg')} />
    ) : (
      <CheckCircle2 className={cn('h-3.5 w-3.5 shrink-0', 'text-bridges-success')} />
    );
  return (
    <div className="rounded-md border border-bridges-border-subtle bg-bridges-surface px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        {iconNode}
        <span className="text-[12.5px] font-semibold text-bridges-fg1">{title}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}
