import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  type ReplayPreviewResponse,
  type ReplayLaunchResponse,
  type ArtifactFile,
} from '@/lib/api';
import { ArtifactPreview } from './ArtifactPreview';

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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type DrawerTab = 'timeline' | 'artifacts' | 'replay' | 'raw';

export function MissionDetailDrawer({
  runId,
  onClose,
}: MissionDetailDrawerProps): React.ReactElement {
  const [tab, setTab] = useState<DrawerTab>('timeline');

  return (
    <Sheet
      open={runId !== null}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        className="flex h-[85dvh] flex-col sm:h-auto sm:max-h-[90dvh] sm:!inset-y-0 sm:!right-0 sm:!left-auto sm:w-[32rem] sm:max-w-md sm:!bottom-0 sm:!top-0"
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
  // Run + persisted events. SSE events come from the mission store and stack
  // on top of these for the timeline view.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mission.runDetail', runId],
    queryFn: () => getWorkflowRun(runId),
    refetchInterval: 5_000,
  });

  return (
    <>
      <SheetHeader>
        <SheetTitle className="truncate">{data?.run.workflow_name ?? 'Run'}</SheetTitle>
        <SheetDescription className="truncate font-mono text-[11px]">{runId}</SheetDescription>
      </SheetHeader>

      <DrawerActions
        runId={runId}
        status={data?.run.status ?? null}
        workerPlatformId={data?.run.worker_platform_id ?? null}
      />

      <Tabs
        value={tab}
        onValueChange={v => {
          onTabChange(v as DrawerTab);
        }}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <TabsList className="self-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="replay">Replay</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="flex-1 overflow-y-auto pr-2">
          <TimelinePane runId={runId} />
        </TabsContent>

        <TabsContent value="artifacts" className="flex-1 overflow-y-auto pr-2">
          <ArtifactsPane runId={runId} />
        </TabsContent>

        <TabsContent value="replay" className="flex-1 overflow-y-auto pr-2">
          <ReplayPane runId={runId} onClose={onClose} />
        </TabsContent>

        <TabsContent value="raw" className="flex-1 overflow-y-auto pr-2">
          {isLoading && <p className="text-sm text-text-secondary">Loading…</p>}
          {isError && <p className="text-sm text-error">Failed to load run.</p>}
          {data && (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-3 font-mono text-[11px] text-text-primary">
              {JSON.stringify(data, null, 2)}
            </pre>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}

function DrawerActions({
  runId,
  status,
  workerPlatformId,
}: {
  runId: string;
  status: string | null;
  workerPlatformId: string | null;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isActive = status === 'running' || status === 'pending';
  const isPaused = status === 'paused';
  const isFailed = status === 'failed';
  const isTerminal = status !== null && TERMINAL_STATUSES.has(status);

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await queryClient.invalidateQueries({ queryKey: ['mission.runDetail', runId] });
      await queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
      await queryClient.invalidateQueries({ queryKey: ['mission.statusBar.counts'] });
      await queryClient.invalidateQueries({ queryKey: ['mission.approvals'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-y border-border py-2">
      <div className="flex flex-wrap gap-2">
        {isActive && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              void run('cancel', () => cancelWorkflowRun(runId));
            }}
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        {isPaused && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                void run('approve', () => approveWorkflowRun(runId));
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
                void run('reject', () => rejectWorkflowRun(runId));
              }}
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </>
        )}
        {isFailed && (
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void run('resume', () => resumeWorkflowRun(runId));
            }}
          >
            {busy === 'resume' ? 'Resuming…' : 'Resume'}
          </Button>
        )}
        {!isTerminal && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              void run('abandon', () => abandonWorkflowRun(runId));
            }}
          >
            {busy === 'abandon' ? 'Abandoning…' : 'Abandon'}
          </Button>
        )}
        {workerPlatformId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              navigate(`/chat/${encodeURIComponent(workerPlatformId)}`);
            }}
          >
            Open conversation
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

function ArtifactsPane({ runId }: { runId: string }): React.ReactElement {
  const [selected, setSelected] = useState<ArtifactFile | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['mission.runArtifacts', runId],
    queryFn: () => listArtifacts(runId),
    refetchInterval: 10_000,
  });

  if (isLoading) return <p className="text-sm text-text-secondary">Loading…</p>;
  if (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load';
    if (msg.includes('404')) {
      return <p className="text-sm text-text-secondary">No artifacts written by this run.</p>;
    }
    return <p className="text-sm text-error">{msg}</p>;
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-text-secondary">No artifacts written by this run.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1">
        {data.map(f => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => {
                setSelected(f);
              }}
              className={
                selected?.path === f.path
                  ? 'flex w-full justify-between gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-left text-sm text-primary'
                  : 'flex w-full justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-primary hover:bg-surface-elevated'
              }
            >
              <span className="truncate font-mono text-[11px]">{f.path}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-tertiary">
                {f.mimeType.split(';')[0]?.split('/')[1] ?? '—'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && <ArtifactPreview runId={runId} file={selected} />}
    </div>
  );
}

function TimelinePane({ runId }: { runId: string }): React.ReactElement {
  // Live events from SSE stream. Persisted events from getWorkflowRun query are
  // useful for cold-start, but for now the live stream is the primary source —
  // the prior RunTimelineDrawer worked the same way.
  const eventTimeline = useMissionStore(s => s.eventTimeline);
  const events = eventTimeline.get(runId) ?? [];
  const filtered = events.filter(e => TIMELINE_EVENT_TYPES.has(e.type));

  if (filtered.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        No events yet. New events will appear here as they stream in.
      </p>
    );
  }

  return (
    <ol className="relative space-y-3 border-l-2 border-border pl-4">
      {filtered.map((event, idx) => (
        <li key={`${event.runId}-${String(idx)}-${String(event.timestamp)}`} className="relative">
          <span className="absolute -left-[22px] top-1 h-3 w-3 rounded-full bg-primary" />
          <div className="text-xs uppercase tracking-wide text-text-secondary">
            {event.type.replace(/_/g, ' ')}
          </div>
          <div className="text-xs text-text-secondary">
            {new Date(event.timestamp).toLocaleTimeString()}
          </div>
          <PayloadFields payload={event.payload} />
        </li>
      ))}
    </ol>
  );
}

function PayloadFields({
  payload,
}: {
  payload: Record<string, unknown>;
}): React.ReactElement | null {
  const fields: { label: string; value: string }[] = [];
  if (typeof payload.name === 'string') fields.push({ label: 'name', value: payload.name });
  if (typeof payload.toolName === 'string') fields.push({ label: 'tool', value: payload.toolName });
  if (typeof payload.stepName === 'string') fields.push({ label: 'step', value: payload.stepName });
  if (typeof payload.status === 'string') fields.push({ label: 'status', value: payload.status });
  if (typeof payload.error === 'string') fields.push({ label: 'error', value: payload.error });
  if (fields.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-text-primary">
      {fields.map(f => (
        <li key={f.label}>
          <span className="text-text-secondary">{f.label}:</span> {f.value}
        </li>
      ))}
    </ul>
  );
}

type ReplayState =
  | { kind: 'idle' }
  | { kind: 'loading' }
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

  if (isLoading) return <p className="text-sm text-text-secondary">Checking for drift…</p>;
  if (error) {
    return (
      <p className="text-sm text-error">
        {error instanceof Error ? error.message : 'Failed to load replay preview'}
      </p>
    );
  }
  if (state.kind === 'launching') {
    return <p className="text-sm text-text-secondary">Launching replay…</p>;
  }
  if (state.kind === 'launched') {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-text-primary">New run started.</p>
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
    return <p className="text-sm text-error">{state.message}</p>;
  }
  if (!data) return <p className="text-sm text-text-secondary">No data.</p>;

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
      <p className="text-text-primary">
        Workflow: <span className="font-medium">{preview.workflow_name}</span>
      </p>
      {hasDrift ? (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="font-medium text-warning">Drift detected</p>
          {drift.yaml_changed && (
            <p className="text-xs text-text-primary">
              Workflow YAML has changed since the original run.
            </p>
          )}
          {drift.repo_head_changed && (
            <p className="text-xs text-text-primary">
              Repository HEAD has moved since the original run.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-text-secondary">
          No drift detected (or original hashes were not recorded).
        </p>
      )}
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-text-secondary">Current YAML</dt>
        <dd className="font-mono text-text-primary">{drift.current_yaml_hash.slice(0, 12)}</dd>
        {drift.original_yaml_hash && (
          <>
            <dt className="text-text-secondary">Original YAML</dt>
            <dd className="font-mono text-text-primary">{drift.original_yaml_hash.slice(0, 12)}</dd>
          </>
        )}
        {drift.current_repo_head && (
          <>
            <dt className="text-text-secondary">Current HEAD</dt>
            <dd className="font-mono text-text-primary">{drift.current_repo_head.slice(0, 12)}</dd>
          </>
        )}
        {drift.original_repo_head && (
          <>
            <dt className="text-text-secondary">Original HEAD</dt>
            <dd className="font-mono text-text-primary">{drift.original_repo_head.slice(0, 12)}</dd>
          </>
        )}
      </dl>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" onClick={onConfirm}>
          {hasDrift ? 'Replay anyway' : 'Confirm replay'}
        </Button>
      </div>
    </div>
  );
}
