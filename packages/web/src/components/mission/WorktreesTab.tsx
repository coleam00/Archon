import { useQuery, useQueries } from '@tanstack/react-query';
import { GitBranch, Terminal } from 'lucide-react';
import { listCodebases, getCodebaseEnvironments } from '@/lib/api';
import type { CodebaseResponse, IsolationEnvironment } from '@/lib/api';
import { Mono } from './primitives';

function formatDaysIdle(days: number): string {
  if (days < 1) {
    const hours = days * 24;
    if (hours < 1) {
      const minutes = hours * 60;
      return `${String(Math.round(minutes))}m`;
    }
    return `${hours.toFixed(1)}h`;
  }
  if (days < 10) return `${days.toFixed(1)}d`;
  return `${String(Math.round(days))}d`;
}

function buildEnvQuery(c: CodebaseResponse): {
  queryKey: readonly unknown[];
  queryFn: () => Promise<IsolationEnvironment[]>;
  refetchInterval: number;
} {
  return {
    queryKey: ['mission.worktrees.envs', c.id],
    queryFn: () => getCodebaseEnvironments(c.id),
    refetchInterval: 30_000,
  };
}

interface FlatRow {
  env: IsolationEnvironment;
  codebase: CodebaseResponse;
}

/**
 * Per-codebase list of active isolation environments. Each row is a worktree
 * (branch + path + age). Read-only for now — the "Complete" lifecycle action
 * stays CLI-only (`archon complete <branch>`) until a server-side wrapper
 * around `isolationCompleteCommand` exists.
 */
export function WorktreesTab(): React.ReactElement {
  const { data: codebases, isLoading: codebasesLoading } = useQuery({
    queryKey: ['mission.worktrees.codebases'],
    queryFn: () => listCodebases(),
  });

  const envQueries = useQueries({
    queries: (codebases ?? []).map(buildEnvQuery),
  });

  const rows: FlatRow[] = [];
  (codebases ?? []).forEach((cb, idx) => {
    const envs = envQueries[idx]?.data ?? [];
    for (const env of envs) {
      if (env.status !== 'active') continue;
      rows.push({ env, codebase: cb });
    }
  });
  rows.sort((a, b) => a.env.days_since_activity - b.env.days_since_activity);

  return (
    <div className="px-6 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">Worktrees</h1>
        <span className="text-[13px] text-bridges-fg3">
          {rows.length} active isolation environments under{' '}
          <Mono className="text-bridges-fg2">~/.archon/workspaces</Mono>
        </span>
      </div>

      {codebasesLoading && <p className="text-sm text-bridges-fg2">Loading codebases…</p>}
      {!codebasesLoading && (!codebases || codebases.length === 0) && (
        <p className="text-[12.5px] text-bridges-fg3">No codebases registered.</p>
      )}
      {!codebasesLoading && rows.length === 0 && codebases && codebases.length > 0 && (
        <div className="rounded-xl border border-bridges-border bg-bridges-surface px-4 py-12 text-center text-[12.5px] text-bridges-fg3">
          No active worktrees.
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-bridges-border bg-bridges-surface">
          <div className="grid grid-cols-[1fr_180px_140px_140px_110px_36px] border-b border-bridges-border-subtle bg-bridges-bg px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-bridges-fg3">
            <div>Branch</div>
            <div>Codebase</div>
            <div>Status</div>
            <div>Path</div>
            <div>Idle</div>
            <div />
          </div>
          {rows.map((r, i) => (
            <div
              key={r.env.id}
              className="grid grid-cols-[1fr_180px_140px_140px_110px_36px] items-center px-3.5 py-2.5 text-[13px]"
              style={{
                borderBottom:
                  i === rows.length - 1 ? 'none' : '1px solid var(--bridges-border-subtle)',
              }}
            >
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-bridges-fg2" />
                <Mono className="text-[12px] text-bridges-fg1">{r.env.branch_name}</Mono>
              </div>
              <div className="font-mono text-[12px] text-bridges-fg2">{r.codebase.name}</div>
              <div className="flex items-center gap-1.5">
                <span className="h-[7px] w-[7px] rounded-full bg-bridges-warning" />
                <span className="text-[12px] text-bridges-fg1">active</span>
              </div>
              <span
                className="truncate font-mono text-[11px] text-bridges-fg2"
                title={r.env.working_path ?? ''}
              >
                {r.env.working_path}
              </span>
              <span className="text-[12px] text-bridges-fg2">
                {formatDaysIdle(r.env.days_since_activity)}
              </span>
              <button
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1"
                title="Open in terminal"
                disabled
              >
                <Terminal className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
