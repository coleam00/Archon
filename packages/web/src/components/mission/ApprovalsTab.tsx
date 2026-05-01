import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, ArrowRight } from 'lucide-react';
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
import {
  Mono,
  ProviderChip,
  Tag,
  fmtAgo,
  runIdentifier,
  runProvider,
  runApprovalReason,
  runBranch,
} from './primitives';

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
    return runs.filter(r => getApproval(r) !== null);
  }, [data]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 pb-6 pt-4">
      <div className="mb-4">
        <h1 className="m-0 mb-1 text-[18px] font-semibold tracking-tight text-bridges-fg1">
          Approvals
        </h1>
        <p className="m-0 text-[13px] text-bridges-fg2">
          {pending.length === 0
            ? 'Nothing waiting on you. The dispatcher will surface anything that needs a gate here.'
            : `${pending.length.toString()} ${pending.length === 1 ? 'run is' : 'runs are'} paused at a human gate. Approve to resume; reject to cancel and write a comment.`}
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-bridges-fg2">Loading…</p>
      ) : pending.length === 0 ? (
        <div className="rounded-xl border border-bridges-border bg-bridges-surface px-6 py-12 text-center">
          <div
            className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full"
            style={{
              background: 'var(--bridges-tint-success-bg)',
              color: 'var(--bridges-success)',
            }}
          >
            <Check className="h-[22px] w-[22px]" />
          </div>
          <div className="text-sm font-medium text-bridges-fg1">All clear</div>
          <div className="mt-1 text-[12.5px] text-bridges-fg3">
            No runs waiting on you right now.
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {pending.map(run => (
            <ApprovalCard key={run.id} run={run} />
          ))}
        </ul>
      )}
    </div>
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

  const reason = approval?.message ?? runApprovalReason(run);
  const branch = runBranch(run);

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
    <li className="flex items-stretch gap-4 rounded-xl border border-bridges-border bg-bridges-surface p-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2">
          <Mono className="text-[11.5px] text-bridges-fg2">{runIdentifier(run)}</Mono>
          <ProviderChip provider={runProvider(run)} />
          <Tag>{run.workflow_name.replace('archon-', '')}</Tag>
          <span className="ml-auto text-[11.5px] text-bridges-fg3">
            paused {fmtAgo(run.last_activity_at ?? run.started_at)}
          </span>
        </div>
        <div className="mb-2 text-[15px] font-medium leading-snug text-bridges-fg1">
          {run.workflow_name}
        </div>
        <div className="mb-2.5 font-mono text-[12px] text-bridges-fg2">
          {approval?.nodeId && (
            <>
              paused at <span className="text-bridges-fg1">{approval.nodeId}</span>
            </>
          )}
          {branch && (
            <>
              {approval?.nodeId ? ' · ' : ''}branch{' '}
              <span className="text-bridges-fg1">{branch}</span>
            </>
          )}
        </div>
        {reason && (
          <div className="rounded-md border border-[#DDD6FE] bg-[#F5F3FF] px-3 py-2.5 text-[13px] leading-snug text-[#5B21B6]">
            <span className="mr-1.5 font-semibold">Why this is paused:</span>
            <span className="whitespace-pre-wrap">{reason}</span>
          </div>
        )}
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
          {error && <p className="text-xs text-bridges-danger">{error}</p>}
        </div>
      </div>

      <div className="w-[1px] self-stretch bg-bridges-border-subtle" />

      <div className="flex w-[160px] flex-col justify-center gap-2">
        <Button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            void handleApprove();
          }}
          className="border-0"
          style={{
            background: 'var(--bridges-tint-success-bg)',
            color: 'var(--bridges-tint-success-fg)',
          }}
        >
          <Check className="h-3.5 w-3.5" />
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            setRejectOpen(true);
          }}
          className="border-0"
          style={{
            background: 'var(--bridges-tint-danger-bg)',
            color: 'var(--bridges-tint-danger-fg)',
          }}
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null}>
          Open
          <ArrowRight className="h-3 w-3" />
        </Button>
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
              <code className="ml-1 rounded bg-bridges-surface-subtle px-1 py-0.5 text-xs">
                $REJECTION_REASON
              </code>
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
