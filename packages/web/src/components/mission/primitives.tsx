import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { WorkflowRunStatus } from '@/lib/types';

// ---------- Time formatting ----------

export function fmtAgo(ts: number | string | null | undefined): string {
  if (ts == null) return '—';
  const ms = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s).toString()}s ago`;
  if (s < 3600) return `${Math.floor(s / 60).toString()}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600).toString()}h ago`;
  return `${Math.floor(s / 86_400).toString()}d ago`;
}

export function fmtDur(
  fromTs: number | string | null | undefined,
  toTs?: number | string | null
): string {
  if (fromTs == null) return '—';
  const from = typeof fromTs === 'string' ? new Date(fromTs).getTime() : fromTs;
  const to = toTs == null ? Date.now() : typeof toTs === 'string' ? new Date(toTs).getTime() : toTs;
  const s = Math.max(0, (to - from) / 1000);
  if (s < 60) return `${Math.floor(s).toString()}s`;
  if (s < 3600) return `${Math.floor(s / 60).toString()}m ${Math.floor(s % 60).toString()}s`;
  return `${Math.floor(s / 3600).toString()}h ${Math.floor((s % 3600) / 60).toString()}m`;
}

// ---------- Run status mapping ----------

export interface StatusVisual {
  /** Tailwind class for the saturated dot/icon color. */
  color: string;
  /** CSS hex for inline styles (avatar/dot background). */
  hex: string;
  label: string;
  /** Render the dot as an outline ring rather than a filled circle. */
  ring?: boolean;
}

export const RUN_STATUS: Record<WorkflowRunStatus, StatusVisual> = {
  running: { color: 'bg-bridges-warning', hex: '#F59E0B', label: 'Running' },
  paused: { color: 'bg-bridges-trigger', hex: '#8B5CF6', label: 'Awaiting approval' },
  completed: { color: 'bg-bridges-success', hex: '#10B981', label: 'Completed' },
  failed: { color: 'bg-bridges-danger', hex: '#EF4444', label: 'Failed' },
  cancelled: { color: 'bg-bridges-neutral', hex: '#71717A', label: 'Cancelled' },
  pending: { color: 'bg-bridges-neutral', hex: '#71717A', label: 'Queued', ring: true },
};

export function StatusDot({
  status,
  size = 8,
}: {
  status: WorkflowRunStatus;
  size?: number;
}): React.ReactElement {
  const s = RUN_STATUS[status];
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: s.ring ? 'transparent' : s.hex,
        border: s.ring ? `1.5px solid ${s.hex}` : 'none',
      }}
    />
  );
}

export function StatusChip({
  status,
  className,
}: {
  status: WorkflowRunStatus;
  className?: string;
}): React.ReactElement {
  const s = RUN_STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-bridges-border bg-bridges-surface px-2 py-0.5 text-[12px] leading-none text-bridges-fg1',
        className
      )}
    >
      <StatusDot status={status} />
      <span>{s.label}</span>
    </span>
  );
}

// ---------- Provider chip ----------

export type ProviderName = string;

const PROVIDER_TINT: Record<string, { bg: string; fg: string }> = {
  Claude: { bg: 'var(--bridges-tag-peach-bg)', fg: 'var(--bridges-tag-peach-fg)' },
  Codex: { bg: 'var(--bridges-tag-mint-bg)', fg: 'var(--bridges-tag-mint-fg)' },
  Pi: { bg: 'var(--bridges-tag-lilac-bg)', fg: 'var(--bridges-tag-lilac-fg)' },
};

export function ProviderChip({ provider }: { provider: ProviderName }): React.ReactElement {
  const t = PROVIDER_TINT[provider] ?? {
    bg: 'var(--bridges-surface-muted)',
    fg: 'var(--bridges-fg2)',
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-tight"
      style={{ background: t.bg, color: t.fg }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: t.fg }} />
      {provider}
    </span>
  );
}

// ---------- Tag ----------

const TAG_TINTS_BY_NAME: Record<string, { bg: string; fg: string }> = {
  feature: { bg: 'var(--bridges-tag-violet-bg)', fg: 'var(--bridges-tag-violet-fg)' },
  bug: { bg: 'var(--bridges-tag-pink-bg)', fg: 'var(--bridges-tag-pink-fg)' },
  chore: { bg: 'var(--bridges-surface-muted)', fg: 'var(--bridges-fg2)' },
  infra: { bg: 'var(--bridges-tag-butter-bg)', fg: 'var(--bridges-tag-butter-fg)' },
  docs: { bg: 'var(--bridges-tag-sky-bg)', fg: 'var(--bridges-tag-sky-fg)' },
  refactor: { bg: 'var(--bridges-tag-lilac-bg)', fg: 'var(--bridges-tag-lilac-fg)' },
  eval: { bg: 'var(--bridges-tag-mint-bg)', fg: 'var(--bridges-tag-mint-fg)' },
  symphony: { bg: 'var(--bridges-tag-violet-bg)', fg: 'var(--bridges-tag-violet-fg)' },
  manual: { bg: 'var(--bridges-surface-muted)', fg: 'var(--bridges-fg2)' },
};

export function Tag({
  children,
  mono = false,
  className,
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}): React.ReactElement {
  const key = typeof children === 'string' ? children.toLowerCase() : '';
  const t = TAG_TINTS_BY_NAME[key] ?? {
    bg: 'var(--bridges-surface-subtle)',
    fg: 'var(--bridges-fg2)',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11.5px] font-medium leading-tight',
        mono && 'font-mono',
        className
      )}
      style={{ background: t.bg, color: t.fg }}
    >
      {children}
    </span>
  );
}

// ---------- Mono / Kbd ----------

export function Mono({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <span className={cn('font-mono text-[12px] text-bridges-fg2', className)}>{children}</span>
  );
}

export function Kbd({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-bridges-border bg-bridges-surface px-1 font-mono text-[11px] font-medium leading-none text-bridges-fg3">
      {children}
    </span>
  );
}

// ---------- Mapping helpers ----------

/** Pick a display identifier — Linear ticket id (if available in metadata) or the workflow name. */
export function runIdentifier(run: {
  workflow_name: string;
  metadata?: Record<string, unknown>;
}): string {
  const m = run.metadata;
  if (m && typeof m === 'object') {
    const linear = (m as { linear_issue?: { identifier?: string } }).linear_issue;
    if (linear && typeof linear.identifier === 'string') return linear.identifier;
    const linearId = (m as { linear_identifier?: string }).linear_identifier;
    if (typeof linearId === 'string') return linearId;
  }
  return run.workflow_name;
}

/** Best-effort provider name from metadata. */
export function runProvider(run: { metadata?: Record<string, unknown> }): ProviderName {
  const m = run.metadata;
  if (m && typeof m === 'object') {
    const a = (m as { assistant?: string; provider?: string }).assistant;
    if (typeof a === 'string') {
      const lc = a.toLowerCase();
      if (lc.startsWith('claude')) return 'Claude';
      if (lc.startsWith('codex')) return 'Codex';
      if (lc.startsWith('pi')) return 'Pi';
      return a;
    }
    const p = (m as { provider?: string }).provider;
    if (typeof p === 'string') return p;
  }
  return 'Claude';
}

/** Best-effort branch name from metadata. */
export function runBranch(run: { metadata?: Record<string, unknown> }): string | null {
  const m = run.metadata;
  if (m && typeof m === 'object') {
    const b = (m as { branch?: string; worktree_branch?: string }).branch;
    if (typeof b === 'string') return b;
    const wb = (m as { worktree_branch?: string }).worktree_branch;
    if (typeof wb === 'string') return wb;
  }
  return null;
}

/** Approval reason for paused runs. */
export function runApprovalReason(run: { metadata?: Record<string, unknown> }): string | null {
  const m = run.metadata;
  if (m && typeof m === 'object') {
    const approval = (m as { approval?: { reason?: string; description?: string } }).approval;
    if (approval) {
      if (typeof approval.reason === 'string') return approval.reason;
      if (typeof approval.description === 'string') return approval.description;
    }
  }
  return null;
}

/** PR shape from metadata. */
export function runPullRequest(run: {
  metadata?: Record<string, unknown>;
}): { number: number; title?: string; url?: string } | null {
  const m = run.metadata;
  if (m && typeof m === 'object') {
    const pr =
      (
        m as {
          pull_request?: { number?: number; title?: string; url?: string };
          pr?: { number?: number; title?: string; url?: string };
        }
      ).pull_request ?? (m as { pr?: { number?: number; title?: string; url?: string } }).pr;
    if (pr && typeof pr.number === 'number') {
      return { number: pr.number, title: pr.title, url: pr.url };
    }
  }
  return null;
}

export function runProgress(run: {
  agents_completed?: number | null;
  total_steps?: number | null;
}): number {
  const completed = run.agents_completed ?? 0;
  const total = run.total_steps ?? 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, completed / total));
}
