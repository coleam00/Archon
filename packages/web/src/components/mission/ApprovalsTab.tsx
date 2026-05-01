import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listDashboardRuns, approveWorkflowRun, rejectWorkflowRun } from '@/lib/api';
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

interface ApprovalContext {
  nodeId?: string;
  message?: string;
  type?: string;
}

function getApproval(run: DashboardRunResponse): ApprovalContext | null {
  const meta = run.metadata as { approval?: ApprovalContext } | null;
  return meta?.approval ?? null;
}

export function ApprovalsTab(): React.ReactElement {
  const { data, isLoading } = useQuery({
    queryKey: ['mission.approvals'],
    queryFn: () => listDashboardRuns({ status: 'paused', limit: 100 }),
    refetchInterval: 10_000,
  });

  const pending = useMemo(() => {
    const runs = data?.runs ?? [];
    // A paused run only needs the operator if it carries an approval block in metadata.
    // Other paused runs (e.g. waiting on a child workflow) shouldn't appear here.
    return runs.filter(r => getApproval(r) !== null);
  }, [data]);

  if (isLoading) {
    return <p className="text-sm text-text-secondary">Loading…</p>;
  }
  if (pending.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface-elevated p-6 text-center">
        <p className="text-sm font-medium text-text-primary">Nothing waiting on you.</p>
        <p className="mt-1 text-xs text-text-secondary">
          Paused runs with an approval gate will appear here.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {pending.map(run => (
        <ApprovalCard key={run.id} run={run} />
      ))}
    </ul>
  );
}

function ApprovalCard({ run }: { run: DashboardRunResponse }): React.ReactElement {
  const approval = getApproval(run);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [approveComment, setApproveComment] = useState('');

  const startedAt = run.started_at ? new Date(run.started_at) : null;
  const waitingFor = startedAt ? formatWaiting(Date.now() - startedAt.getTime()) : '—';

  async function invalidate(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['mission.approvals'] });
    await queryClient.invalidateQueries({ queryKey: ['mission.statusBar.counts'] });
    await queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
  }

  async function handleApprove(): Promise<void> {
    setBusy('approve');
    setError(null);
    try {
      await approveWorkflowRun(run.id, approveComment || undefined);
      setApproveComment('');
      await invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(): Promise<void> {
    setBusy('reject');
    setError(null);
    try {
      await rejectWorkflowRun(run.id, rejectReason || undefined);
      setRejectReason('');
      setRejectOpen(false);
      await invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reject failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-md border border-warning/30 bg-warning/5 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-warning">
              Awaiting approval
            </span>
            <span className="text-xs text-text-tertiary">· waiting {waitingFor}</span>
          </div>
          <p className="mt-1 truncate font-medium text-text-primary">{run.workflow_name}</p>
          <p className="truncate text-xs text-text-secondary">
            {run.codebase_name ?? '—'}
            {approval?.nodeId ? ` · node ${approval.nodeId}` : ''}
          </p>
          {approval?.message && (
            <p className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary">
              {approval.message}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Textarea
          placeholder="Optional comment on approve…"
          value={approveComment}
          onChange={e => {
            setApproveComment(e.target.value);
          }}
          rows={2}
          className="text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void handleApprove();
            }}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              setRejectOpen(true);
            }}
          >
            Reject…
          </Button>
        </div>
        {error && <p className="text-xs text-error">{error}</p>}
      </div>

      <Dialog
        open={rejectOpen}
        onOpenChange={open => {
          if (!open && busy !== 'reject') setRejectOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject — {run.workflow_name}</DialogTitle>
            <DialogDescription>
              The reason will be passed to the workflow's `on_reject` prompt as
              <code className="ml-1 rounded bg-surface px-1 py-0.5 text-xs">$REJECTION_REASON</code>
              .
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Why are you rejecting this?"
            value={rejectReason}
            onChange={e => {
              setRejectReason(e.target.value);
            }}
            rows={4}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy === 'reject'}
              onClick={() => {
                setRejectOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy === 'reject'}
              onClick={() => {
                void handleReject();
              }}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function formatWaiting(ms: number): string {
  if (ms < 60_000) return `${String(Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${String(Math.floor(ms / 60_000))}m`;
  if (ms < 86_400_000) return `${String(Math.floor(ms / 3_600_000))}h`;
  return `${String(Math.floor(ms / 86_400_000))}d`;
}
