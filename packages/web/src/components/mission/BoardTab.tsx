import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  listDashboardRuns,
  cancelWorkflowRun,
  resumeWorkflowRun,
  approveWorkflowRun,
  rejectWorkflowRun,
} from '@/lib/api';
import type { DashboardRunResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface BoardTabProps {
  onOpenRun: (runId: string) => void;
}

type LaneId = 'queued' | 'running' | 'paused' | 'failed' | 'recent';

const LANES: {
  id: LaneId;
  label: string;
  tone: 'muted' | 'info' | 'warn' | 'error' | 'success';
}[] = [
  { id: 'queued', label: 'Queued', tone: 'muted' },
  { id: 'running', label: 'Running', tone: 'info' },
  { id: 'paused', label: 'Awaiting approval', tone: 'warn' },
  { id: 'failed', label: 'Failed', tone: 'error' },
  { id: 'recent', label: 'Recently completed', tone: 'success' },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function laneFor(run: DashboardRunResponse): LaneId | null {
  switch (run.status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'cancelled': {
      // Only show in Recent if finished within the last 24h.
      if (!run.completed_at) return null;
      const ts = new Date(run.completed_at).getTime();
      return Date.now() - ts < ONE_DAY_MS ? 'recent' : null;
    }
    default:
      return null;
  }
}

interface PendingAction {
  kind: 'reject' | 'cancel-confirm';
  runId: string;
  workflowName: string;
}

export function BoardTab({ onOpenRun }: BoardTabProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['mission.board.runs'],
    queryFn: () => listDashboardRuns({ limit: 100 }),
    refetchInterval: 5_000,
  });

  const grouped = useMemo(() => {
    const map: Record<LaneId, DashboardRunResponse[]> = {
      queued: [],
      running: [],
      paused: [],
      failed: [],
      recent: [],
    };
    for (const run of data?.runs ?? []) {
      const lane = laneFor(run);
      if (lane) map[lane].push(run);
    }
    return map;
  }, [data]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  async function invalidate(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['mission.board.runs'] });
    await queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
    await queryClient.invalidateQueries({ queryKey: ['mission.statusBar.counts'] });
    await queryClient.invalidateQueries({ queryKey: ['mission.approvals'] });
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    setActionError(null);
    const runId = String(event.active.id);
    const targetLane = event.over?.id as LaneId | undefined;
    if (!targetLane) return;

    const run = data?.runs.find(r => r.id === runId);
    if (!run) return;
    const sourceLane = laneFor(run);
    if (sourceLane === targetLane) return;

    // Encode the valid transitions explicitly. Anything else is a no-op
    // (the card snaps back to its original lane).
    const transition = `${sourceLane ?? '?'}->${targetLane}`;
    try {
      switch (transition) {
        case 'paused->running':
          await approveWorkflowRun(runId);
          break;
        case 'paused->failed':
          // Reject needs a reason — open the dialog and stop here. The dialog
          // will run the actual API call on confirm.
          setPending({ kind: 'reject', runId, workflowName: run.workflow_name });
          return;
        case 'failed->running':
          await resumeWorkflowRun(runId);
          break;
        case 'running->failed':
        case 'running->recent':
        case 'paused->recent':
        case 'queued->recent':
          // Treat "drag onto Recent" or onto Failed as a cancel intent. Confirm
          // because cancel is destructive and we don't want a fat-finger drag
          // to kill an active run.
          setPending({ kind: 'cancel-confirm', runId, workflowName: run.workflow_name });
          return;
        default:
          // Unsupported transition — show a quiet message and do nothing.
          setActionError(
            `Can't move from ${LANES.find(l => l.id === sourceLane)?.label ?? sourceLane} to ${LANES.find(l => l.id === targetLane)?.label ?? targetLane}.`
          );
          return;
      }
      await invalidate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    }
  }

  return (
    <div className="space-y-3">
      {actionError && (
        <div className="rounded-md border border-error/30 bg-error/5 px-3 py-2 text-sm text-error">
          {actionError}
        </div>
      )}
      {isLoading && <p className="text-sm text-text-secondary">Loading…</p>}

      <DndContext
        sensors={sensors}
        onDragEnd={e => {
          void handleDragEnd(e);
        }}
      >
        <div className="grid gap-3 lg:grid-cols-5 md:grid-cols-3 sm:grid-cols-2 grid-cols-1">
          {LANES.map(lane => (
            <Lane key={lane.id} lane={lane} runs={grouped[lane.id]} onOpenRun={onOpenRun} />
          ))}
        </div>
      </DndContext>

      <RejectDialog
        pending={pending}
        onClose={() => {
          setPending(null);
        }}
        onAfterAction={() => {
          void invalidate();
        }}
      />
      <CancelConfirmDialog
        pending={pending}
        onClose={() => {
          setPending(null);
        }}
        onAfterAction={() => {
          void invalidate();
        }}
      />
    </div>
  );
}

function Lane({
  lane,
  runs,
  onOpenRun,
}: {
  lane: (typeof LANES)[number];
  runs: DashboardRunResponse[];
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const { isOver, setNodeRef } = useDroppable({ id: lane.id });
  const toneBorder = {
    muted: 'border-border',
    info: 'border-primary/30',
    warn: 'border-warning/30',
    error: 'border-error/30',
    success: 'border-success/30',
  }[lane.tone];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md border bg-surface-elevated p-2 transition-colors',
        toneBorder,
        isOver && 'bg-primary/5 ring-1 ring-primary'
      )}
    >
      <div className="flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          {lane.label}
        </span>
        <span className="text-xs text-text-tertiary">{runs.length}</span>
      </div>
      <ul className="mt-2 space-y-2">
        {runs.length === 0 && (
          <li className="rounded-md border border-dashed border-border bg-surface px-2 py-3 text-center text-[11px] text-text-tertiary">
            empty
          </li>
        )}
        {runs.map(run => (
          <BoardCard key={run.id} run={run} onOpenRun={onOpenRun} />
        ))}
      </ul>
    </div>
  );
}

function BoardCard({
  run,
  onOpenRun,
}: {
  run: DashboardRunResponse;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: run.id });

  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => {
        onOpenRun(run.id);
      }}
      className={cn(
        'cursor-grab rounded-md border border-border bg-surface px-2 py-2 text-sm shadow-sm hover:bg-surface-elevated active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
    >
      <p className="truncate font-medium text-text-primary">{run.workflow_name}</p>
      <p className="truncate text-xs text-text-secondary">
        {run.codebase_name ?? '—'}
        {run.current_step_name ? ` · ${run.current_step_name}` : ''}
      </p>
      {run.status === 'paused' && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-warning">
          drag → ✓ approve / ✗ reject
        </p>
      )}
      {run.status === 'failed' && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-text-tertiary">
          drag → Running to resume
        </p>
      )}
    </li>
  );
}

function RejectDialog({
  pending,
  onClose,
  onAfterAction,
}: {
  pending: PendingAction | null;
  onClose: () => void;
  onAfterAction: () => void;
}): React.ReactElement {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = pending?.kind === 'reject';

  async function handleConfirm(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await rejectWorkflowRun(pending.runId, reason || undefined);
      setReason('');
      onAfterAction();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen && !busy) {
          setReason('');
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject — {pending?.workflowName ?? ''}</DialogTitle>
          <DialogDescription>
            The reason will be passed to the workflow's `on_reject` prompt as
            <code className="ml-1 rounded bg-surface px-1 py-0.5 text-xs">$REJECTION_REASON</code>.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="Why are you rejecting this?"
          value={reason}
          onChange={e => {
            setReason(e.target.value);
          }}
          rows={4}
        />
        {error && <p className="text-xs text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setReason('');
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {busy ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CancelConfirmDialog({
  pending,
  onClose,
  onAfterAction,
}: {
  pending: PendingAction | null;
  onClose: () => void;
  onAfterAction: () => void;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = pending?.kind === 'cancel-confirm';

  async function handleConfirm(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await cancelWorkflowRun(pending.runId);
      onAfterAction();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={isOpen => {
        if (!isOpen && !busy) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel — {pending?.workflowName ?? ''}</DialogTitle>
          <DialogDescription>
            This stops the run and tears down its isolation environment if one exists. The run will
            be marked cancelled.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Keep running
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {busy ? 'Cancelling…' : 'Confirm cancel'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
