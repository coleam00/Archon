import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle, ChevronRight, Loader2, Pause, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { approveWorkflowRun, getWorkflowRunByWorker, rejectWorkflowRun } from '@/lib/api';
import { useWorkflowStore } from '@/stores/workflow-store';
import { StatusIcon } from '@/components/workflows/StatusIcon';
import { formatDurationMs } from '@/lib/format';
import { t } from '@/lib/i18n';
import { isTerminalStatus } from '@/lib/workflow-utils';
import type { DagNodeState } from '@/lib/types';

interface WorkflowProgressCardProps {
  workflowName: string;
  workerConversationId: string;
}

export function WorkflowProgressCard({
  workflowName,
  workerConversationId,
}: WorkflowProgressCardProps): React.ReactElement {
  const navigate = useNavigate();

  // REST polling for run data (stops when terminal)
  const {
    data: runData,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['workflowRunByWorker', workerConversationId],
    queryFn: () => getWorkflowRunByWorker(workerConversationId),
    refetchInterval: (query): number | false => {
      const status = query.state.data?.run?.status;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return false;
      return 3000;
    },
  });

  const runId = runData?.run?.id;
  const restStatus = runData?.run?.status;

  // Live SSE state from Zustand store
  const liveState = useWorkflowStore(state => (runId ? state.workflows.get(runId) : undefined));

  // Merge: prefer live state when available
  const status = liveState?.status ?? restStatus;
  const dagNodes: DagNodeState[] = liveState?.dagNodes ?? [];
  const currentTool = liveState?.currentTool ?? null;
  const approval = liveState?.approval ?? null;
  const error = liveState?.error;
  const startedAt = liveState?.startedAt;

  const completedCount = dagNodes.filter(n => n.status === 'completed').length;
  const totalNodes = dagNodes.length;
  const isRunning = status === 'running' || status === 'pending';
  const isPaused = status === 'paused';

  // Expand/collapse state
  const [expanded, setExpanded] = useState(false);
  const userToggled = useRef(false);

  // Auto-expand when running or paused, auto-collapse when terminal (unless user toggled)
  useEffect(() => {
    if (userToggled.current) return;
    if (isRunning || isPaused) {
      setExpanded(true);
    } else if (isTerminalStatus(status)) {
      setExpanded(false);
    }
  }, [isRunning, isPaused, status]);

  // Live elapsed timer
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || !startedAt) return;
    setElapsed(Date.now() - startedAt);
    const interval = setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [isRunning, startedAt]);

  // Approve/reject mutations
  const approveMutation = useMutation({
    mutationFn: () => approveWorkflowRun(runId ?? ''),
  });
  const rejectMutation = useMutation({
    mutationFn: () => rejectWorkflowRun(runId ?? ''),
  });
  const mutationError = approveMutation.error ?? rejectMutation.error;

  // Completed duration from live state
  const completedAt = liveState?.completedAt;
  const finalDuration = completedAt && startedAt ? completedAt - startedAt : null;

  const handleHeaderClick = (): void => {
    userToggled.current = true;
    setExpanded(prev => !prev);
  };

  const handleViewFullScreen = (): void => {
    if (runId) {
      navigate(`/workflows/runs/${runId}`);
    } else {
      navigate(`/chat/${encodeURIComponent(workerConversationId)}`);
    }
  };

  // Loading state: no run data yet
  if (!runData && !isError) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs max-w-md">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
        <span className="truncate text-text-primary font-medium">{workflowName}</span>
        <span className="text-text-tertiary">{t('chat.workflowStarting')}</span>
      </div>
    );
  }

  // Error state: couldn't fetch run
  if (isError && !runData) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs max-w-md">
        <span className="text-error text-xs shrink-0">&#x26A0;</span>
        <span className="truncate text-text-primary font-medium">{workflowName}</span>
        <button
          onClick={(): void => {
            refetch();
          }}
          className="text-primary hover:text-accent-bright transition-colors shrink-0"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface transition-colors max-w-md overflow-hidden',
        isRunning && 'border-l-2 border-l-primary',
        isPaused && 'border-l-2 border-l-warning'
      )}
    >
      {/* Header bar - always visible, clickable */}
      <button
        onClick={handleHeaderClick}
        className="flex h-9 w-full items-center gap-2 px-3 text-left"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <span className="shrink-0">
          <StatusIcon status={status ?? 'pending'} />
        </span>
        <span className="truncate text-xs font-medium text-text-primary">{workflowName}</span>
        {totalNodes > 0 && (
          <span className="shrink-0 text-[10px] text-text-secondary">
            {String(completedCount)}/{String(totalNodes)} {t('dashboard.nodes')}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {isRunning && elapsed > 0 ? (
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] text-primary">
              {formatDurationMs(elapsed)}
            </span>
          ) : finalDuration != null ? (
            <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] text-text-secondary">
              {formatDurationMs(finalDuration)}
            </span>
          ) : null}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border">
          {/* Node list */}
          {dagNodes.length > 0 && (
            <div className="space-y-0.5 px-3 py-2">
              {dagNodes.map((node: DagNodeState) => (
                <div key={node.nodeId} className="flex items-center gap-2 text-xs py-0.5">
                  <span className="shrink-0">
                    <StatusIcon status={node.status} />
                  </span>
                  <span className="truncate flex-1 text-text-secondary">{node.name}</span>
                  {node.duration !== undefined && (
                    <span className="shrink-0 text-[10px] text-text-tertiary">
                      {formatDurationMs(node.duration)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Approval request banner */}
          {isPaused && (
            <div className="border-t border-border px-3 py-2 space-y-2">
              <div className="rounded-md bg-warning/5 border border-warning/20 px-3 py-2 flex items-start gap-2">
                <Pause className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-xs text-text-secondary">
                  {approval?.message ?? t('chat.waitingForApproval')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    approveMutation.mutate();
                  }}
                  disabled={!runId || approveMutation.isPending || rejectMutation.isPending}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-success/80 hover:bg-success/10 hover:text-success transition-colors disabled:opacity-50"
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  {t('dashboard.approve')}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(`${t('chat.rejectWorkflowConfirmPrefix')}${workflowName}`)) {
                      rejectMutation.mutate();
                    }
                  }}
                  disabled={!runId || approveMutation.isPending || rejectMutation.isPending}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/80 hover:bg-error/10 hover:text-error transition-colors disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {t('dashboard.reject')}
                </button>
              </div>
              {(approveMutation.isError || rejectMutation.isError) && (
                <p className="text-xs text-error">
                  {mutationError instanceof Error ? mutationError.message : t('chat.actionFailed')}
                </p>
              )}
            </div>
          )}

          {/* Current tool activity */}
          {currentTool?.status === 'running' && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-border">
              <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
              <span className="truncate font-mono text-primary">{currentTool.name}</span>
            </div>
          )}

          {/* Error message */}
          {status === 'failed' && error && (
            <div
              className="px-3 py-1.5 text-xs text-error border-t border-border truncate"
              title={error}
            >
              {error.slice(0, 120)}
            </div>
          )}

          {/* Footer: View Full Screen */}
          <div className="border-t border-border px-3 py-1.5">
            <button
              onClick={handleViewFullScreen}
              className="text-[10px] text-primary hover:text-accent-bright transition-colors"
            >
              {t('chat.viewFullScreen')} &rarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
