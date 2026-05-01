import { GitBranch, GitPullRequest, Clock } from 'lucide-react';
import type { DashboardRunResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  StatusDot,
  ProviderChip,
  Mono,
  fmtDur,
  runIdentifier,
  runProvider,
  runApprovalReason,
  runPullRequest,
  runProgress,
  RUN_STATUS,
} from './primitives';

interface RunCardProps {
  run: DashboardRunResponse;
  onClick?: () => void;
  dragging?: boolean;
  compact?: boolean;
}

export function RunCard({
  run,
  onClick,
  dragging = false,
  compact = false,
}: RunCardProps): React.ReactElement {
  const identifier = runIdentifier(run);
  const provider = runProvider(run);
  const approvalReason = runApprovalReason(run);
  const pr = runPullRequest(run);
  const progress = runProgress(run);
  const status = RUN_STATUS[run.status];

  return (
    <div
      onClick={onClick}
      className={cn(
        'cursor-grab select-none rounded-lg border border-bridges-border bg-bridges-surface transition-shadow hover:border-bridges-border-strong',
        compact ? 'p-2.5' : 'p-3',
        dragging && 'shadow-[0_12px_24px_rgba(15,15,18,0.10),0_4px_8px_rgba(15,15,18,0.06)]'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Mono className="text-[11px] text-bridges-fg2">{identifier}</Mono>
        <div className="flex-1" />
        <ProviderChip provider={provider} />
      </div>

      <div className="mb-2 text-[13px] font-medium leading-snug text-bridges-fg1">
        {run.workflow_name}
      </div>

      {(run.current_step_name ?? run.user_message) && (
        <div className="mb-2 flex items-center gap-1.5">
          <StatusDot status={run.status} size={7} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-bridges-fg2">
            {run.current_step_name ?? run.user_message.slice(0, 80)}
          </span>
        </div>
      )}

      <div className="mb-2 h-[3px] overflow-hidden rounded-full bg-bridges-surface-muted">
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${(progress * 100).toFixed(0)}%`, background: status.hex }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {run.codebase_name && (
            <span
              className="rounded px-1.5 py-0.5 text-[11.5px] font-medium leading-tight"
              style={{
                background: 'var(--bridges-surface-subtle)',
                color: 'var(--bridges-fg2)',
              }}
            >
              {run.codebase_name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-bridges-fg3">
          <Clock className="h-3 w-3" />
          <span className="font-mono">
            {fmtDur(run.started_at, run.completed_at ?? Date.now())}
          </span>
        </div>
      </div>

      {run.status === 'paused' && approvalReason && (
        <div className="mt-2.5 rounded-md border border-[#DDD6FE] bg-[#F5F3FF] px-2.5 py-2 text-[11.5px] leading-snug text-[#5B21B6]">
          {approvalReason}
        </div>
      )}

      {run.status === 'failed' && (
        <div className="mt-2.5 rounded-md border border-[#FECACA] bg-[#FEF2F2] px-2.5 py-2 font-mono text-[11.5px] leading-snug text-[#B91C1C]">
          {extractErrorSummary(run.metadata) ?? 'Run failed.'}
        </div>
      )}

      {run.status === 'completed' && pr && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-md bg-bridges-surface-muted px-2.5 py-2 text-[11.5px] text-bridges-fg1">
          <GitPullRequest className="h-3 w-3 text-bridges-success" />
          <Mono className="text-[11.5px] text-bridges-fg1">PR #{pr.number}</Mono>
          {pr.title && <span className="min-w-0 flex-1 truncate text-bridges-fg2">{pr.title}</span>}
        </div>
      )}

      <BranchLine metadata={run.metadata} />
    </div>
  );
}

function extractErrorSummary(metadata: Record<string, unknown>): string | null {
  const err =
    (metadata as { error?: string; failure_reason?: string }).error ??
    (metadata as { failure_reason?: string }).failure_reason;
  if (typeof err === 'string') return err;
  return null;
}

function BranchLine({
  metadata,
}: {
  metadata: Record<string, unknown>;
}): React.ReactElement | null {
  const m = metadata as { branch?: string; worktree_branch?: string };
  const branch = m.branch ?? m.worktree_branch;
  if (!branch) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[11px] text-bridges-fg3">
      <GitBranch className="h-3 w-3" />
      <Mono className="text-[11px] text-bridges-fg2">{branch}</Mono>
    </div>
  );
}
