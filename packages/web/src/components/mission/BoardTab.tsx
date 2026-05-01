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
import { Kbd } from './primitives';
import { RunCard } from './RunCard';

interface BoardTabProps {
  onOpenRun: (runId: string) => void;
}

type LaneId = 'paused' | 'running' | 'completed' | 'failed';

const LANES: { id: LaneId; label: string; dot: string }[] = [
  { id: 'paused', label: 'Awaiting approval', dot: '#8B5CF6' },
  { id: 'running', label: 'Running', dot: '#F59E0B' },
  { id: 'completed', label: 'Completed', dot: '#10B981' },
  { id: 'failed', label: 'Failed', dot: '#EF4444' },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function laneFor(run: DashboardRunResponse): LaneId | null {
  switch (run.status) {
    case 'paused':
      return 'paused';
    case 'pending':
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'completed':
    case 'cancelled': {
      if (!run.completed_at) return null;
      const ts = new Date(run.completed_at).getTime();
      return Date.now() - ts < ONE_DAY_MS ? 'completed' : null;
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

interface DragAction {
  kind: 'approve' | 'reject' | 'resume' | 'cancel';
  label: string;
}

function dragActionFor(sourceLane: LaneId | null, targetLane: LaneId): DragAction | null {
  if (sourceLane === targetLane) return null;
  if (targetLane === 'failed' && sourceLane === 'paused')
    return { kind: 'reject', label: 'Reject' };
  if (targetLane === 'failed' && sourceLane === 'running')
    return { kind: 'cancel', label: 'Cancel' };
  if (targetLane === 'running' && sourceLane === 'paused')
    return { kind: 'approve', label: 'Approve' };
  if (targetLane === 'running' && sourceLane === 'failed')
    return { kind: 'resume', label: 'Resume' };
  return null;
}

export function BoardTab({ onOpenRun }: BoardTabProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['mission.board.runs'],
    queryFn: () => listDashboardRuns({ limit: 100 }),
    refetchInterval: 5_000,
  });

  const grouped = useMemo(() => {
    const map: Record<LaneId, DashboardRunResponse[]> = {
      paused: [],
      running: [],
      completed: [],
      failed: [],
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
    setActiveId(null);
    setActionError(null);
    const runId = String(event.active.id);
    const targetLane = event.over?.id as LaneId | undefined;
    if (!targetLane) return;

    const run = data?.runs.find(r => r.id === runId);
    if (!run) return;
    const sourceLane = laneFor(run);
    const action = dragActionFor(sourceLane, targetLane);
    if (!action) return;

    try {
      switch (action.kind) {
        case 'approve':
          await approveWorkflowRun(runId);
          break;
        case 'reject':
          setPending({ kind: 'reject', runId, workflowName: run.workflow_name });
          return;
        case 'resume':
          await resumeWorkflowRun(runId);
          break;
        case 'cancel':
          setPending({ kind: 'cancel-confirm', runId, workflowName: run.workflow_name });
          return;
      }
      await invalidate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    }
  }

  const dragSrc = activeId ? (data?.runs.find(r => r.id === activeId) ?? null) : null;
  const dragSrcLane = dragSrc ? laneFor(dragSrc) : null;

  return (
    <div className="px-5 pb-6 pt-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <h1 className="m-0 text-[18px] font-semibold tracking-tight text-bridges-fg1">Board</h1>
        <span className="text-[12px] text-bridges-fg3">
          drag <Kbd>card</Kbd> to a lane to act
          <span className="ml-1.5 text-[11px]">
            — Awaiting → Running approve · Awaiting → Failed reject · Failed → Running resume ·
            Running → Failed cancel
          </span>
        </span>
      </div>

      {actionError && (
        <div className="mb-3 rounded-md border border-bridges-danger/40 bg-bridges-tint-danger-bg px-3 py-2 text-sm text-bridges-tint-danger-fg">
          {actionError}
        </div>
      )}
      {isLoading && <p className="text-sm text-bridges-fg2">Loading…</p>}

      <DndContext
        sensors={sensors}
        onDragStart={e => {
          setActiveId(String(e.active.id));
        }}
        onDragCancel={() => {
          setActiveId(null);
        }}
        onDragEnd={e => {
          void handleDragEnd(e);
        }}
      >
        <div className="flex items-start gap-3">
          {LANES.map(lane => (
            <Lane
              key={lane.id}
              lane={lane}
              runs={grouped[lane.id]}
              dragSrcLane={dragSrcLane}
              onOpenRun={onOpenRun}
            />
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
  dragSrcLane,
  onOpenRun,
}: {
  lane: (typeof LANES)[number];
  runs: DashboardRunResponse[];
  dragSrcLane: LaneId | null;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const { isOver, setNodeRef } = useDroppable({ id: lane.id });
  const action = dragSrcLane ? dragActionFor(dragSrcLane, lane.id) : null;
  const allowed = action != null;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-w-[280px] flex-1 flex-col rounded-xl border-[1.5px] border-dashed p-2 transition-colors',
        isOver && allowed ? 'bg-bridges-surface-subtle' : 'border-transparent bg-transparent'
      )}
      style={isOver && allowed ? { borderColor: lane.dot } : undefined}
    >
      <div className="flex items-center gap-2 px-2 pb-2.5 pt-1">
        <span className="h-2 w-2 rounded-full" style={{ background: lane.dot }} />
        <span className="text-[12px] font-semibold text-bridges-fg1">{lane.label}</span>
        <span className="text-[11px] tabular-nums text-bridges-fg3">{runs.length}</span>
        <div className="flex-1" />
        {dragSrcLane && (
          <span
            className={cn(
              'rounded-full px-[7px] py-[2px] text-[10px] font-semibold uppercase tracking-[0.05em]',
              allowed ? 'text-white' : 'text-bridges-fg-placeholder'
            )}
            style={{ background: allowed ? lane.dot : 'transparent' }}
          >
            {allowed ? action.label : '—'}
          </span>
        )}
      </div>
      <div className="flex min-h-[80px] flex-col gap-2">
        {runs.length === 0 && (
          <div className="px-2.5 py-3 text-center text-[11.5px] italic text-bridges-fg-placeholder">
            no runs
          </div>
        )}
        {runs.map(run => (
          <DraggableCard key={run.id} run={run} onOpenRun={onOpenRun} />
        ))}
      </div>
    </div>
  );
}

function DraggableCard({
  run,
  onOpenRun,
}: {
  run: DashboardRunResponse;
  onOpenRun: (runId: string) => void;
}): React.ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: run.id });
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={{ opacity: isDragging ? 0.4 : 1 }}>
      <RunCard
        run={run}
        dragging={isDragging}
        onClick={() => {
          onOpenRun(run.id);
        }}
      />
    </div>
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
            <code className="ml-1 rounded bg-bridges-surface-subtle px-1 py-0.5 text-xs">
              $REJECTION_REASON
            </code>
            .
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
        {error && <p className="text-xs text-bridges-danger">{error}</p>}
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
        {error && <p className="text-xs text-bridges-danger">{error}</p>}
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
