import deployStatus from '@/lib/deploy-status.generated.json';

// D3 footer: deploy-chain status (Greg Queue B 2026-06-11). One-line proof that
// the Tailscale Funnel → Caddy → auth-proxy → Vite chain is alive and where the
// dashboard lives. Built from build-deploy-status-json.py at cron time.

interface ChainHop {
  hop: string;
  role: string;
}

interface FunnelStatus {
  available: string;
  reason?: string;
  exit_code?: string;
  first_line?: string;
  line_count?: string;
}

interface DeployStatusPayload {
  generated_at: string;
  chain: ChainHop[];
  canonical_url: string;
  doc: string;
  funnel_status: FunnelStatus;
}

function formatTs(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

export function DeployStatusFooter(): React.ReactElement {
  const data = deployStatus as Partial<DeployStatusPayload>;
  const funnelOk = data.funnel_status?.available === 'true';
  const chain = data.chain ?? [];
  const chainStr = chain.length > 0 ? chain.map(c => c.hop).join(' → ') : 'deploy chain pending';
  const docPath = data.doc ?? 'deploy-chain doc pending';
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface-elevated px-4 py-1.5 text-[10px] text-text-tertiary">
      <span className="flex items-center gap-1.5">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            funnelOk ? 'bg-emerald-500' : 'bg-amber-500'
          }`}
          aria-hidden="true"
        />
        <span className="font-medium text-text-secondary">
          {funnelOk ? 'Funnel up' : 'Funnel unknown'}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <span className="font-mono">{chainStr}</span>
      <span aria-hidden="true">·</span>
      <span>
        Chain doc: <code className="rounded bg-surface px-1 font-mono">{docPath}</code>
      </span>
      <span aria-hidden="true">·</span>
      <span>Captured {formatTs(data.generated_at)}</span>
    </footer>
  );
}
