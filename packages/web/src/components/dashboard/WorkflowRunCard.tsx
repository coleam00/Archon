import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Globe,
  Terminal,
  Hash,
  Send,
  GitBranch,
  ExternalLink,
  MessageSquare,
  FileText,
  XCircle,
  PlayCircle,
  Ban,
  Trash2,
  CheckCircle,
  AlertTriangle,
  Pause,
} from 'lucide-react';
import type { DashboardRunResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';
import { useWorkflowStore } from '@/stores/workflow-store';
import type { WorkflowState } from '@/lib/types';
import { ConfirmRunActionDialog } from './ConfirmRunActionDialog';

interface WorkflowRunCardProps {
  run: DashboardRunResponse;
  isDocker?: boolean;
  onCancel: (runId: string) => void;
  onResume?: (runId: string) => void;
  onAbandon?: (runId: string) => void;
  onDelete?: (runId: string) => void;
  onApprove?: (runId: string) => void;
  onReject?: (runId: string) => void;
}

const PLATFORM_ICONS: Record<string, React.ReactElement> = {
  web: <Globe className="h-3.5 w-3.5" />,
  cli: <Terminal className="h-3.5 w-3.5" />,
  slack: <Hash className="h-3.5 w-3.5" />,
  telegram: <Send className="h-3.5 w-3.5" />,
  github: <GitBranch className="h-3.5 w-3.5" />,
};

function StepProgress({
  run,
  liveState,
}: {
  run: DashboardRunResponse;
  liveState: WorkflowState | undefined;
}): React.ReactElement | null {
  const dagNodes = liveState?.dagNodes ?? [];
  const runningNode = dagNodes
    .slice()
    .reverse()
    .find(n => n.status === 'running');
  const completedCount = dagNodes.filter(n => n.status === 'completed').length;
  const totalNodes = dagNodes.length || run.total_steps || 0;
  const stepName = runningNode?.name ?? run.current_step_name;
  const currentTool = liveState?.currentTool ?? null;

  const hasProgress = runningNode != null || totalNodes > 0;
  if (!hasProgress && !currentTool) return null;

  return (
    <div className="rounded-md bg-surface-elevated px-3 py-2 space-y-1">
      {hasProgress && (
        <div className="flex items-center gap-2 text-sm text-text-primary">
          <span className="font-medium">
            {`${String(completedCount)}${totalNodes ? `/${String(totalNodes)}` : ''} nodes`}
          </span>
          {stepName && <span className="text-text-secondary">{stepName}</span>}
        </div>
      )}
      {currentTool && (
        <div className="flex items-center gap-2">
          {currentTool.status === 'running' && (
            <div className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          )}
          <span
            className={cn(
              'text-sm font-mono truncate',
              currentTool.status === 'running' ? 'text-primary' : 'text-text-secondary'
            )}
          >
            {currentTool.status === 'running'
              ? currentTool.name
              : `${currentTool.name} (${currentTool.durationMs ? `${(currentTool.durationMs / 1000).toFixed(1)}s` : 'done'})`}
          </span>
        </div>
      )}
    </div>
  );
}

interface NodeCounts {
  completed: number;
  failed: number;
  skipped: number;
  total: number;
}

function isValidNodeCounts(value: unknown): value is NodeCounts {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.completed === 'number' &&
    typeof obj.failed === 'number' &&
    typeof obj.skipped === 'number' &&
    typeof obj.total === 'number'
  );
}

function NodeCountsSummary({ counts }: { counts: NodeCounts }): React.ReactElement {
  const hasFailures = counts.failed > 0 || counts.skipped > 0;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {hasFailures ? (
        <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
      ) : (
        <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />
      )}
      <span className={hasFailures ? 'text-warning' : 'text-success'}>
        {String(counts.completed)}/{String(counts.total)} nodes succeeded
      </span>
      {counts.failed > 0 && (
        <span className="text-text-secondary">&middot; {String(counts.failed)} failed</span>
      )}
      {counts.skipped > 0 && (
        <span className="text-text-secondary">&middot; {String(counts.skipped)} skipped</span>
      )}
    </div>
  );
}

interface PausedApprovalDetails {
  message: string;
  lastOutput?: string;
  lastOutputTruncated?: boolean;
  finalAssistantOutput?: string;
  finalAssistantOutputTruncated?: boolean;
}

function parsePausedApproval(value: unknown): PausedApprovalDetails | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.message !== 'string') {
    return null;
  }

  return {
    message: candidate.message,
    lastOutput: typeof candidate.lastOutput === 'string' ? candidate.lastOutput : undefined,
    lastOutputTruncated:
      typeof candidate.lastOutput === 'string' && typeof candidate.lastOutputTruncated === 'boolean'
        ? candidate.lastOutputTruncated
        : undefined,
    finalAssistantOutput:
      typeof candidate.finalAssistantOutput === 'string'
        ? candidate.finalAssistantOutput
        : undefined,
    finalAssistantOutputTruncated:
      typeof candidate.finalAssistantOutput === 'string' &&
      typeof candidate.finalAssistantOutputTruncated === 'boolean'
        ? candidate.finalAssistantOutputTruncated
        : undefined,
  };
}

function getPausedOutputPreview(
  approval: PausedApprovalDetails | null
): { text: string; truncated: boolean } | null {
  if (!approval) {
    return null;
  }

  const finalAssistantOutput = approval.finalAssistantOutput?.trim() ?? '';
  if (finalAssistantOutput.length > 0) {
    return {
      text: finalAssistantOutput,
      truncated:
        approval.finalAssistantOutputTruncated ??
        finalAssistantOutput.trimEnd().endsWith('[truncated]'),
    };
  }

  const lastOutput = approval.lastOutput?.trim() ?? '';
  if (lastOutput.length === 0) {
    return null;
  }

  return {
    text: lastOutput,
    truncated: approval.lastOutputTruncated ?? lastOutput.trimEnd().endsWith('[truncated]'),
  };
}

export function WorkflowRunCard({
  run,
  isDocker,
  onCancel,
  onResume,
  onAbandon,
  onDelete,
  onApprove,
  onReject,
}: WorkflowRunCardProps): React.ReactElement {
  const navigate = useNavigate();
  const [elapsed, setElapsed] = useState(() => formatDuration(run.started_at, run.completed_at));

  // Live SSE state from Zustand store — overrides REST-polled data when present
  const liveState = useWorkflowStore(state => state.workflows.get(run.id));

  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'paused') return;
    const interval = setInterval(() => {
      setElapsed(formatDuration(run.started_at, null));
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [run.status, run.started_at]);

  const chatId = run.parent_platform_id ?? run.worker_platform_id;
  const [messageExpanded, setMessageExpanded] = useState(false);
  const longMessage = (run.user_message?.length ?? 0) > 80;
  const displayMessage = run.user_message
    ? messageExpanded || !longMessage
      ? run.user_message
      : run.user_message.slice(0, 80) + '…'
    : null;
  const approval = run.status === 'paused' ? parsePausedApproval(run.metadata?.approval) : null;
  const pausedOutputPreview = getPausedOutputPreview(approval);
  const latestOutput = pausedOutputPreview?.text ?? '';
  const hasLatestOutput = latestOutput.length > 0;
  const isLatestOutputClipped = pausedOutputPreview?.truncated ?? false;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      {/* Header: status dot + name + badge + elapsed */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full',
            run.status === 'running' && 'bg-primary animate-pulse',
            run.status === 'paused' && 'bg-warning animate-pulse',
            run.status === 'pending' && 'bg-text-tertiary'
          )}
        />
        <span className="font-medium text-sm text-text-primary truncate flex-1">
          {run.workflow_name}
        </span>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            run.status === 'running' && 'bg-primary/10 text-primary',
            run.status === 'paused' && 'bg-warning/10 text-warning',
            run.status === 'pending' && 'bg-surface-elevated text-text-secondary'
          )}
        >
          {run.status}
        </span>
        <span className="text-xs text-text-tertiary shrink-0">{elapsed}</span>
      </div>

      {/* Live progress */}
      <StepProgress run={run} liveState={liveState} />

      {/* Node outcome summary for completed/failed runs */}
      {(run.status === 'completed' || run.status === 'failed') &&
        isValidNodeCounts(run.metadata?.node_counts) && (
          <div className="flex items-center gap-2">
            <NodeCountsSummary counts={run.metadata.node_counts} />
            {typeof run.metadata?.total_cost_usd === 'number' && (
              <span className="text-xs text-text-secondary">
                ${run.metadata.total_cost_usd.toFixed(4)} USD
              </span>
            )}
          </div>
        )}

      {/* Metadata row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          {PLATFORM_ICONS[run.platform_type ?? ''] ?? <Globe className="h-3.5 w-3.5" />}
          {run.platform_type ?? 'unknown'}
        </span>
        <span>{run.codebase_name ?? 'Unknown project'}</span>
        {run.parent_platform_id && run.parent_platform_id !== run.worker_platform_id && (
          <button
            onClick={(): void => {
              navigate(`/chat/${encodeURIComponent(run.parent_platform_id ?? '')}`);
            }}
            className="flex items-center gap-1 text-primary/80 hover:text-primary transition-colors"
          >
            <MessageSquare className="h-3 w-3" />
            Parent chat
          </button>
        )}
      </div>

      {/* User message — expandable */}
      {displayMessage && (
        <div className="space-y-0.5">
          <p className={cn('text-xs text-text-tertiary italic', !messageExpanded && 'truncate')}>
            {displayMessage}
          </p>
          {longMessage && (
            <button
              onClick={(): void => {
                setMessageExpanded(e => !e);
              }}
              className="text-[10px] text-text-tertiary hover:text-text-secondary underline"
            >
              {messageExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Approval request message */}
      {run.status === 'paused' && (
        <div className="space-y-2">
          <div className="rounded-md bg-warning/5 border border-warning/20 px-3 py-2 flex items-start gap-2">
            <Pause className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary">
              {approval?.message ?? 'Waiting for approval'}
            </p>
          </div>
          {hasLatestOutput && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-text-secondary">Latest output</p>
              {isLatestOutputClipped && (
                <p className="text-[11px] text-warning">
                  Output clipped; showing the latest available text.
                </p>
              )}
              <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-text-secondary whitespace-pre-wrap break-words">
                {latestOutput}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Working path */}
      {run.working_path && (
        <p className="text-[11px] text-text-tertiary truncate">
          Worktree: {run.working_path.split('/').pop()}
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={(): void => {
            navigate(`/workflows/runs/${run.id}`);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <FileText className="h-3.5 w-3.5" />
          View Logs
        </button>
        {chatId && (
          <button
            onClick={(): void => {
              navigate(`/chat/${encodeURIComponent(chatId)}`);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Open Chat
          </button>
        )}
        {run.working_path && !isDocker && (
          <a
            href={`vscode://file/${run.working_path.replace(/\\/g, '/')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in IDE
          </a>
        )}
        <div className="ml-auto flex items-center gap-1">
          {run.status === 'paused' && onApprove && (
            <button
              onClick={(): void => {
                onApprove(run.id);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-success/80 hover:bg-success/10 hover:text-success transition-colors"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              Approve
            </button>
          )}
          {run.status === 'paused' && onReject && (
            <ConfirmRunActionDialog
              trigger={
                <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/80 hover:bg-error/10 hover:text-error transition-colors">
                  <XCircle className="h-3.5 w-3.5" />
                  Reject
                </button>
              }
              title="Reject workflow?"
              description={
                <>
                  Reject the paused workflow <strong>{run.workflow_name}</strong>. The run will be
                  marked as failed and any pending iterations will not continue.
                </>
              }
              confirmLabel="Reject"
              onConfirm={(): void => {
                onReject(run.id);
              }}
            />
          )}
          {run.status === 'failed' && onResume && (
            <button
              onClick={(): void => {
                onResume(run.id);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary/80 hover:bg-primary/10 hover:text-primary transition-colors"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Resume
            </button>
          )}
          {run.status === 'running' && onAbandon && (
            <ConfirmRunActionDialog
              trigger={
                <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-warning/80 hover:bg-warning/10 hover:text-warning transition-colors">
                  <Ban className="h-3.5 w-3.5" />
                  Abandon
                </button>
              }
              title="Abandon workflow?"
              description={
                <>
                  Mark <strong>{run.workflow_name}</strong> as cancelled. Already-completed nodes
                  remain in the database; the run will not continue.
                </>
              }
              confirmLabel="Abandon"
              onConfirm={(): void => {
                onAbandon(run.id);
              }}
            />
          )}
          {(run.status === 'running' || run.status === 'pending') && (
            <ConfirmRunActionDialog
              trigger={
                <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/80 hover:bg-error/10 hover:text-error transition-colors">
                  <XCircle className="h-3.5 w-3.5" />
                  Cancel
                </button>
              }
              title="Cancel workflow?"
              description={
                <>
                  Cancel <strong>{run.workflow_name}</strong>. The run will be marked as cancelled
                  and any in-flight subprocess will be terminated.
                </>
              }
              confirmLabel="Cancel workflow"
              onConfirm={(): void => {
                onCancel(run.id);
              }}
            />
          )}
          {onDelete && run.status !== 'running' && run.status !== 'pending' && (
            <ConfirmRunActionDialog
              trigger={
                <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-tertiary hover:bg-error/10 hover:text-error transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              }
              title="Delete workflow run?"
              description={
                <>
                  Permanently delete the run record for <strong>{run.workflow_name}</strong> and its
                  events. This cannot be undone.
                </>
              }
              confirmLabel="Delete"
              onConfirm={(): void => {
                onDelete(run.id);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
