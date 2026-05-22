import { requestJson } from '../lib/http';
import { toRun, type Run } from '../primitives/run';
import { toRunEvent, type RunEvent } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import type { components } from '@/lib/api.generated';

export interface ListRunsOptions {
  codebaseId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface RunCounts {
  all: number;
  running: number;
  paused: number;
  failed: number;
  completed: number;
  cancelled: number;
  pending: number;
}

interface DashboardRunsResponse {
  runs: Parameters<typeof toRun>[0][];
  total: number;
  counts: Partial<RunCounts>;
}

function normalizeCounts(c: Partial<RunCounts>): RunCounts {
  return {
    all: c.all ?? 0,
    running: c.running ?? 0,
    paused: c.paused ?? 0,
    failed: c.failed ?? 0,
    completed: c.completed ?? 0,
    cancelled: c.cancelled ?? 0,
    pending: c.pending ?? 0,
  };
}

export async function listRuns(
  opts: ListRunsOptions = {}
): Promise<{ runs: Run[]; counts: RunCounts; total: number }> {
  const qs = new URLSearchParams();
  if (opts.codebaseId !== undefined) qs.set('codebaseId', opts.codebaseId);
  if (opts.status !== undefined) qs.set('status', opts.status);
  if (opts.limit !== undefined) qs.set('limit', opts.limit.toString());
  const url = `/api/dashboard/runs${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const res = await requestJson<DashboardRunsResponse>(url);
  return {
    runs: res.runs.map(toRun),
    counts: normalizeCounts(res.counts),
    total: res.total,
  };
}

export async function listGlobalCounts(): Promise<RunCounts> {
  // Counts without any codebase filter — used by top chrome pill.
  const res = await requestJson<DashboardRunsResponse>('/api/dashboard/runs?limit=1');
  return normalizeCounts(res.counts);
}

interface RunDetailResponse {
  run: Parameters<typeof toRun>[0];
  events: Parameters<typeof toRunEvent>[0][];
}

export async function getRun(id: string): Promise<{ run: Run; events: RunEvent[] }> {
  const res = await requestJson<RunDetailResponse>(`/api/workflows/runs/${encodeURIComponent(id)}`);
  return {
    run: toRun(res.run),
    events: res.events.map(toRunEvent),
  };
}

export async function cancelRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function approveRun(id: string, comment?: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(comment !== undefined ? { comment } : {}),
  });
}

export async function rejectRun(id: string, reason: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export async function resumeRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function abandonRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/abandon`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Re-exported from the generated OpenAPI types so the console doesn't drift
 * from the server contract. Schema lives in
 * packages/server/src/routes/schemas/workflow.schemas.ts.
 */
export type ArtifactFile = components['schemas']['ArtifactFile'];
type ListArtifactsResponse = components['schemas']['ListArtifactsResponse'];

export async function listRunArtifacts(runId: string): Promise<ArtifactFile[]> {
  const res = await requestJson<ListArtifactsResponse>(
    `/api/runs/${encodeURIComponent(runId)}/artifacts`
  );
  return res.files;
}

/** Fetch a single artifact file as text (markdown or plain). */
export async function fetchArtifact(runId: string, path: string): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`/api/artifacts/${encodeURIComponent(runId)}/${encodedPath}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch artifact: ${res.status.toString()}`);
  }
  return res.text();
}
