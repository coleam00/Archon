import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  X,
  Check,
  RotateCcw,
  Terminal,
  GitPullRequest,
  GitBranch,
  Clock,
  MoreVertical,
  ExternalLink,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useMissionStore } from '@/stores/mission-store';
import {
  getWorkflowRun,
  cancelWorkflowRun,
  resumeWorkflowRun,
  abandonWorkflowRun,
  approveWorkflowRun,
  rejectWorkflowRun,
  previewReplay,
  launchReplayApi,
  listArtifacts,
  type WorkflowRunResponse,
  type ReplayPreviewResponse,
  type ReplayLaunchResponse,
  type ArtifactFile,
} from '@/lib/api';
import { ArtifactPreview } from './ArtifactPreview';
import { cn } from '@/lib/utils';
import {
  Mono,
  ProviderChip,
  StatusChip,
  Tag,
  fmtAgo,
  fmtDur,
  runProvider,
  runIdentifier,
  runApprovalReason,
  runBranch,
} from './primitives';

interface MissionDetailDrawerProps {
  runId: string | null;
  onClose: () => void;
}

const TIMELINE_EVENT_TYPES = new Set([
  'workflow_status',
  'dag_node',
  'workflow_tool_activity',
  'workflow_step',
  'workflow_artifact',
  'symphony_dispatch_started',
  'symphony_dispatch_completed',
  'symphony_dispatch_failed',
  'symphony_dispatch_cancelled',
]);

const TIMELINE_KIND_COLOR: Record<string, string> = {
  workflow_status: '#3B82F6',
  dag_node: '#71717A',
  workflow_step: '#71717A',
  workflow_tool_activity: '#F59E0B',
  workflow_artifact: '#8B5CF6',
  symphony_dispatch_started: '#3B82F6',
  symphony_dispatch_completed: '#10B981',
  symphony_dispatch_failed: '#EF4444',
  symphony_dispatch_cancelled: '#71717A',
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type DrawerTab = 'timeline' | 'replay' | 'raw' | 'artifacts';

export function MissionDetailDrawer({
  runId,
  onClose,
}: MissionDetailDrawerProps): React.ReactElement {
  const [tab, setTab] = useState<DrawerTab>('timeline');
  useEffect(() => {
    setTab('timeline');
  }, [runId]);

  return (
    <Sheet
      open={runId !== null}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col border-bridges-border-subtle bg-bridges-surface p-0 sm:!w-[580px] sm:!max-w-[580px]"
      >
        {runId ? (
          <DrawerContent runId={runId} tab={tab} onTabChange={setTab} onClose={onClose} />
        ) : (
          <SheetHeader>
            <SheetTitle>Run details</SheetTitle>
            <SheetDescription>—</SheetDescription>
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerContent({
  runId,
  tab,
  onTabChange,
  onClose,
}: {
  runId: string;
  tab: DrawerTab;
  onTabChange: (t: DrawerTab) => void;
  onClose: () => void;
}): React.ReactElement {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mission.runDetail', runId],
    queryFn: () => getWorkflowRun(runId),
    refetchInterval: 5_000,
  });

  const run = data?.run;

  return (
    <div className="flex h-full flex-col">
      <DrawerHeader run={run} runId={runId} onClose={onClose} />
      <DrawerActions runId={runId} run={run} onClose={onClose} />
      <DrawerTabs tab={tab} onTabChange={onTabChange} />

      <div className="flex-1 overflow-y-auto px-[18px] pb-6 pt-3.5">
        {tab === 'timeline' && <TimelinePane runId={runId} run={run} />}
        {tab === 'artifacts' && <ArtifactsPane runId={runId} />}
        {tab === 'replay' && <ReplayPane runId={runId} onClose={onClose} />}
        {tab === 'raw' && (
          <>
            {isLoading && <p className="text-sm text-bridges-fg2">Loading…</p>}
            {isError && <p className="text-sm text-bridges-danger">Failed to load run.</p>}
            {data && <RawPane data={data} />}
          </>
        )}
      </div>
    </div>
  );
}

function DrawerHeader({
  run,
  runId,
  onClose,
}: {
  run: WorkflowRunResponse | undefined;
  runId: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="border-b border-bridges-border-subtle px-[18px] pb-3 pt-3.5">
      <div className="mb-2 flex items-center gap-2">
        <Mono className="text-[11px] text-bridges-fg2">{run ? runIdentifier(run) : '—'}</Mono>
        <span className="text-bridges-border-strong">/</span>
        <Mono className="text-[11px] text-bridges-fg2">{runId.slice(0, 8)}</Mono>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <h2 className="mb-2.5 text-[17px] font-semibold leading-snug text-bridges-fg1">
        {run?.workflow_name ?? 'Loading…'}
      </h2>
      {run && (
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={run.status} />
          <ProviderChip provider={runProvider(run)} />
          <Tag mono>{run.workflow_name}</Tag>
          {runBranch(run) && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-bridges-fg3">
              <GitBranch className="h-3 w-3" />
              <Mono className="text-[11px] text-bridges-fg2">{runBranch(run)}</Mono>
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[11.5px] text-bridges-fg3">
            <Clock className="h-3 w-3" />
            {fmtDur(run.started_at, run.completed_at ?? Date.now())}
          </span>
        </div>
      )}
    </div>
  );
}

function DrawerActions({
  runId,
  run,
  onClose,
}: {
  runId: string;
  run: WorkflowRunResponse | undefined;
  onClose: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = run?.status ?? null;
  const isActive = status === 'running' || status === 'pending';
  const isPaused = status === 'paused';
  const isFailed = status === 'failed';
  const isCompleted = status === 'completed';
  const isTerminal = status !== null && TERMINAL_STATUSES.has(status);
  const workerPlatformId = run?.worker_platform_id ?? null;

  async function actAndInvalidate(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['mission.runDetail', runId] });
      await queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
      await queryClient.invalidateQueries({ queryKey: ['mission.statusBar.counts'] });
      await queryClient.invalidateQueries({ queryKey: ['mission.approvals'] });
      if (label === 'approve' || label === 'reject' || label === 'cancel') onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-b border-bridges-border-subtle px-[18px] pb-2.5 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {isPaused && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                void actAndInvalidate('approve', () => approveWorkflowRun(runId));
              }}
              className="border-0"
              style={{
                background: 'var(--bridges-tint-success-bg)',
                color: 'var(--bridges-tint-success-fg)',
              }}
            >
              <Check className="h-3 w-3" />
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                void actAndInvalidate('reject', () => rejectWorkflowRun(runId));
              }}
              className="border-0"
              style={{
                background: 'var(--bridges-tint-danger-bg)',
                color: 'var(--bridges-tint-danger-fg)',
              }}
            >
              <X className="h-3 w-3" />
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </>
        )}
        {isActive && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                void actAndInvalidate('cancel', () => cancelWorkflowRun(runId));
              }}
            >
              <X className="h-3 w-3" />
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled>
              <Terminal className="h-3 w-3" />
              Attach terminal
            </Button>
          </>
        )}
        {isFailed && (
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void actAndInvalidate('resume', () => resumeWorkflowRun(runId));
            }}
          >
            <RotateCcw className="h-3 w-3" />
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {isCompleted && (
          <Button type="button" size="sm" variant="outline" disabled>
            <GitPullRequest className="h-3 w-3" />
            View PR
          </Button>
        )}
        {!isTerminal && !isPaused && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              void actAndInvalidate('abandon', () => abandonWorkflowRun(runId));
            }}
          >
            {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
          </Button>
        )}
        <div className="flex-1" />
        {workerPlatformId && (
          <button
            onClick={() => {
              navigate(`/chat/${encodeURIComponent(workerPlatformId)}`);
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1"
            title="Open conversation"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1"
          title="More"
          disabled
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-bridges-danger">{error}</p>}
    </div>
  );
}

function DrawerTabs({
  tab,
  onTabChange,
}: {
  tab: DrawerTab;
  onTabChange: (t: DrawerTab) => void;
}): React.ReactElement {
  const TABS: { id: DrawerTab; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'replay', label: 'Replay' },
    { id: 'raw', label: 'Raw events' },
    { id: 'artifacts', label: 'Artifacts' },
  ];
  return (
    <div className="border-b border-bridges-border-subtle bg-bridges-bg px-3.5 pb-2 pt-2.5">
      <div className="inline-flex rounded-md bg-bridges-surface-muted p-0.5">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              onTabChange(t.id);
            }}
            className={cn(
              'rounded px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === t.id
                ? 'bg-bridges-surface text-bridges-fg1 shadow-[0_1px_2px_rgba(15,15,18,0.06)]'
                : 'text-bridges-fg2 hover:text-bridges-fg1'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TimelinePane({
  runId,
  run,
}: {
  runId: string;
  run: WorkflowRunResponse | undefined;
}): React.ReactElement {
  const eventTimeline = useMissionStore(s => s.eventTimeline);
  const events = eventTimeline.get(runId) ?? [];
  const filtered = events.filter(e => TIMELINE_EVENT_TYPES.has(e.type));

  const reason = run ? runApprovalReason(run) : null;

  return (
    <div>
      {run && (
        <div className="mb-3.5 grid grid-cols-3 gap-3 rounded-lg border border-bridges-border-subtle bg-bridges-bg p-3">
          <Stat label="Started" value={fmtAgo(run.started_at)} />
          <Stat label="Provider" value={runProvider(run)} />
          <Stat label="Status" value={run.status} />
        </div>
      )}

      {run?.status === 'paused' && reason && (
        <div className="mb-3.5 rounded-lg border border-[#DDD6FE] bg-[#F5F3FF] p-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#5B21B6]">
            Approval requested
          </div>
          <div className="text-[13px] leading-snug text-[#5B21B6]">{reason}</div>
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-sm text-bridges-fg3">
          No events yet. New events will appear here as they stream in.
        </p>
      )}

      <div className="relative pl-4">
        <div className="absolute bottom-1.5 left-1 top-1.5 w-px bg-bridges-border" />
        {filtered.map((event, idx) => {
          const color = TIMELINE_KIND_COLOR[event.type] ?? '#71717A';
          const summary = summarize(event.payload);
          const isToolCall = event.type === 'workflow_tool_activity';
          return (
            <div
              key={`${event.runId}-${String(idx)}-${String(event.timestamp)}`}
              className="relative pb-3.5"
            >
              <span
                className="absolute -left-4 top-1 h-2.5 w-2.5 rounded-full border-2 border-white"
                style={{ background: color, boxShadow: '0 0 0 1px var(--bridges-border)' }}
              />
              <div className="mb-0.5 flex items-center gap-2">
                <span
                  className="text-[10.5px] font-semibold uppercase tracking-[0.05em]"
                  style={{ color }}
                >
                  {event.type.replace(/_/g, ' ')}
                </span>
                <Mono className="text-[10.5px] text-bridges-fg3">
                  {typeof event.payload.name === 'string' ? event.payload.name : ''}
                </Mono>
                <div className="flex-1" />
                <Mono className="text-[10.5px] text-bridges-fg-placeholder">
                  {fmtAgo(event.timestamp)}
                </Mono>
              </div>
              <div
                className={cn(
                  'text-[12.5px] leading-snug text-bridges-fg1',
                  isToolCall && 'font-mono'
                )}
              >
                {summary || event.type}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <div className="mb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-bridges-fg3">
        {label}
      </div>
      <div className="text-[13px] font-medium text-bridges-fg1">{value}</div>
    </div>
  );
}

function summarize(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.name === 'string') parts.push(payload.name);
  if (typeof payload.toolName === 'string') parts.push(`tool:${payload.toolName}`);
  if (typeof payload.stepName === 'string') parts.push(`step:${payload.stepName}`);
  if (typeof payload.status === 'string') parts.push(`→${payload.status}`);
  if (typeof payload.error === 'string') parts.push(`error:${payload.error.slice(0, 80)}`);
  return parts.join(' · ');
}

function ArtifactsPane({ runId }: { runId: string }): React.ReactElement {
  const [selected, setSelected] = useState<ArtifactFile | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['mission.runArtifacts', runId],
    queryFn: () => listArtifacts(runId),
    refetchInterval: 10_000,
  });

  if (isLoading) return <p className="text-sm text-bridges-fg2">Loading…</p>;
  if (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load';
    if (msg.includes('404')) {
      return <p className="text-sm text-bridges-fg3">No artifacts written by this run.</p>;
    }
    return <p className="text-sm text-bridges-danger">{msg}</p>;
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-bridges-fg3">No artifacts written by this run.</p>;
  }

  return (
    <div className="space-y-2">
      {data.map(f => {
        const ext = f.mimeType.split(';')[0]?.split('/')[1] ?? '—';
        const sizeKb = f.size ? `${(f.size / 1024).toFixed(0)} KB` : '';
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => {
              setSelected(prev => (prev?.path === f.path ? null : f));
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors',
              selected?.path === f.path
                ? 'border-bridges-border-strong bg-bridges-surface-subtle'
                : 'border-bridges-border bg-bridges-surface hover:border-bridges-border-strong'
            )}
          >
            <Mono className="flex-1 truncate text-[12px] text-bridges-fg1">{f.name}</Mono>
            <span className="text-[11px] text-bridges-fg3">{sizeKb}</span>
            <Tag>{ext}</Tag>
          </button>
        );
      })}
      {selected && (
        <div className="mt-3 rounded-lg border border-bridges-border bg-bridges-surface p-2">
          <ArtifactPreview runId={runId} file={selected} />
        </div>
      )}
    </div>
  );
}

type ReplayState =
  | { kind: 'idle' }
  | { kind: 'preview'; preview: ReplayPreviewResponse['preview'] }
  | { kind: 'launching' }
  | { kind: 'launched'; result: ReplayLaunchResponse['result'] }
  | { kind: 'error'; message: string };

function ReplayPane({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const { data, error, isLoading } = useQuery({
    queryKey: ['mission.replayPreview', runId],
    queryFn: () => previewReplay(runId),
  });
  const [state, setState] = useState<ReplayState>({ kind: 'idle' });

  async function handleConfirm(): Promise<void> {
    setState({ kind: 'launching' });
    try {
      const res = await launchReplayApi(runId);
      setState({ kind: 'launched', result: res.result });
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to launch replay',
      });
    }
  }

  if (isLoading) return <p className="text-sm text-bridges-fg2">Checking for drift…</p>;
  if (error) {
    return (
      <p className="text-sm text-bridges-danger">
        {error instanceof Error ? error.message : 'Failed to load replay preview'}
      </p>
    );
  }
  if (state.kind === 'launching') {
    return <p className="text-sm text-bridges-fg2">Launching replay…</p>;
  }
  if (state.kind === 'launched') {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-bridges-fg1">New run started.</p>
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={() => {
              navigate(`/workflows/runs/${state.result.new_run_id}`);
              onClose();
            }}
          >
            Open run
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return <p className="text-sm text-bridges-danger">{state.message}</p>;
  }
  if (!data) return <p className="text-sm text-bridges-fg2">No data.</p>;

  return <DriftBlock preview={data.preview} onConfirm={handleConfirm} />;
}

function DriftBlock({
  preview,
  onConfirm,
}: {
  preview: ReplayPreviewResponse['preview'];
  onConfirm: () => void;
}): React.ReactElement {
  const drift = preview.drift;
  const hasDrift = drift.yaml_changed || drift.repo_head_changed;

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-bridges-border-subtle bg-bridges-bg p-4">
        <div className="mb-2.5 flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-bridges-open" />
          <span className="text-[14px] font-semibold text-bridges-fg1">Replay this run</span>
        </div>
        <p className="m-0 mb-3.5 text-[13px] leading-relaxed text-bridges-fg2">
          Re-execute <Mono className="text-bridges-fg1">{preview.workflow_name}</Mono> against the
          same input snapshot in a fresh worktree branched from current main.
        </p>
        {hasDrift ? (
          <div className="space-y-1 rounded-md border border-[#DDD6FE] bg-[#F5F3FF] p-3 text-[#5B21B6]">
            <p className="font-medium">Drift detected</p>
            {drift.yaml_changed && (
              <p className="text-xs">Workflow YAML has changed since the original run.</p>
            )}
            {drift.repo_head_changed && (
              <p className="text-xs">Repository HEAD has moved since the original run.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-bridges-fg3">
            No drift detected (or original hashes were not recorded).
          </p>
        )}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-bridges-fg3">Current YAML</dt>
          <dd className="font-mono text-bridges-fg1">{drift.current_yaml_hash.slice(0, 12)}</dd>
          {drift.original_yaml_hash && (
            <>
              <dt className="text-bridges-fg3">Original YAML</dt>
              <dd className="font-mono text-bridges-fg1">
                {drift.original_yaml_hash.slice(0, 12)}
              </dd>
            </>
          )}
          {drift.current_repo_head && (
            <>
              <dt className="text-bridges-fg3">Current HEAD</dt>
              <dd className="font-mono text-bridges-fg1">{drift.current_repo_head.slice(0, 12)}</dd>
            </>
          )}
          {drift.original_repo_head && (
            <>
              <dt className="text-bridges-fg3">Original HEAD</dt>
              <dd className="font-mono text-bridges-fg1">
                {drift.original_repo_head.slice(0, 12)}
              </dd>
            </>
          )}
        </dl>
        <div className="mt-3 flex justify-end">
          <Button type="button" onClick={onConfirm}>
            {hasDrift ? 'Replay anyway' : 'Confirm replay'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RawPane({
  data,
}: {
  data: {
    run: WorkflowRunResponse;
    events: { id: string; event_type: string; created_at: string; data: Record<string, unknown> }[];
  };
}): React.ReactElement {
  return (
    <pre className="m-0 max-h-full overflow-auto rounded-lg bg-bridges-fg1 p-3 font-mono text-[11.5px] leading-snug text-[#A1A1AA]">
      <span className="text-bridges-fg3">{`# ${data.events.length.toString()} events  ·  workflow_run=${data.run.id}\n# tail -f workflow_events.jsonl\n\n`}</span>
      {data.events.map(ev => (
        <div key={ev.id} className="flex gap-2.5">
          <span className="text-bridges-neutral">
            {new Date(ev.created_at).toISOString().slice(11, 23)}
          </span>
          <span
            style={{ color: TIMELINE_KIND_COLOR[ev.event_type] ?? '#A1A1AA' }}
            className="min-w-[120px]"
          >
            {ev.event_type}
          </span>
          <span className="flex-1 text-[#E4E4E7]">{summarize(ev.data) || '—'}</span>
        </div>
      ))}
    </pre>
  );
}
