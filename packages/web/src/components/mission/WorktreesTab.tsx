import { useQuery, useQueries } from '@tanstack/react-query';
import { listCodebases, getCodebaseEnvironments } from '@/lib/api';
import type { CodebaseResponse, IsolationEnvironment } from '@/lib/api';

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

/**
 * Per-codebase list of active isolation environments. Each row is a worktree
 * (branch + path + age). Read-only for now — the "Complete" lifecycle action
 * stays CLI-only (`archon complete <branch>`) until a server-side wrapper
 * around `isolationCompleteCommand` exists. See plan
 * `/Users/desha/.claude/plans/implement-the-remaing-phases-humming-raccoon.md`
 * for the rest endpoint sketch.
 */
export function WorktreesTab(): React.ReactElement {
  const { data: codebases, isLoading: codebasesLoading } = useQuery({
    queryKey: ['mission.worktrees.codebases'],
    queryFn: () => listCodebases(),
  });

  const envQueries = useQueries({
    queries: (codebases ?? []).map(buildEnvQuery),
  });

  if (codebasesLoading) return <p className="text-sm text-text-secondary">Loading codebases…</p>;
  if (!codebases || codebases.length === 0) {
    return <p className="text-sm text-text-secondary">No codebases registered.</p>;
  }

  return (
    <div className="space-y-6">
      {codebases.map((cb, idx) => (
        <CodebaseGroup
          key={cb.id}
          codebase={cb}
          environments={envQueries[idx]?.data ?? []}
          isLoading={envQueries[idx]?.isLoading ?? false}
        />
      ))}
    </div>
  );
}

function CodebaseGroup({
  codebase,
  environments,
  isLoading,
}: {
  codebase: CodebaseResponse;
  environments: IsolationEnvironment[];
  isLoading: boolean;
}): React.ReactElement {
  // Filter to active worktrees only — destroyed environments are noise here.
  const active = environments.filter(e => e.status === 'active');
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between border-b border-border pb-1">
        <h2 className="text-sm font-semibold text-text-primary">{codebase.name}</h2>
        <span className="text-xs text-text-tertiary">{active.length} active</span>
      </div>
      {isLoading && <p className="text-sm text-text-secondary">Loading…</p>}
      {!isLoading && active.length === 0 && (
        <p className="text-sm text-text-secondary">No active worktrees.</p>
      )}
      {active.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Branch</th>
                <th className="px-3 py-2 text-left font-medium">Path</th>
                <th className="px-3 py-2 text-right font-medium">Days idle</th>
              </tr>
            </thead>
            <tbody>
              {active.map(env => (
                <tr key={env.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-[12px] text-text-primary">
                    {env.branch_name}
                  </td>
                  <td className="px-3 py-2 truncate font-mono text-[11px] text-text-secondary max-w-[24rem]">
                    {env.working_path}
                  </td>
                  <td className="px-3 py-2 text-right text-text-secondary">
                    {formatDaysIdle(env.days_since_activity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
