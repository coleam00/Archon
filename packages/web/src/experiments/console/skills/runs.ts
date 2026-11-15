import type { paths } from '@/lib/api.generated';
import type { ListRunsOptions, RunsAttention } from '../primitives/run';
export type { ListRunsOptions, RunsAttention } from '../primitives/run';
import { requestJson, buildApiUrl } from '../lib/http';
import { toRun, type Run } from '../primitives/run';
import { toRunEvent, type RunEvent, type RunNodeState } from '../primitives/event';
import type { components } from '@/lib/api.generated';

type DashboardRunsResponse = components['schemas']['DashboardRunsResponse'];
export type RunCounts = DashboardRunsResponse['counts'];

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
  const res = await requestJson('/api/dashboard/runs', 'get', {
    query: {
      codebaseId: opts.codebaseId,
      status: opts.status,
      limit: opts.limit?.toString(),
      offset: opts.offset?.toString(),
    },
  });
  return {
    runs: res.runs.map(toRun),
    counts: normalizeCounts(res.counts),
    total: res.total,
  };
}

export async function listRunsNeedingAttention(): Promise<RunsAttention> {
  const res = await requestJson('/api/runs/attention', 'get');
  if (!('runs' in res)) throw new Error('Attention endpoint returned counts instead of runs');
  return { runs: res.runs.map(toRun), degraded: res.degraded ?? [] };
}

export async function listGlobalCounts(): Promise<RunCounts> {
  // Counts without any codebase filter — used by top chrome pill.
  const res = await requestJson('/api/dashboard/runs', 'get', { query: { limit: '1' } });
  return normalizeCounts(res.counts);
}

export async function getRun(
  id: string
): Promise<{ run: Run; events: RunEvent[]; nodes: RunNodeState[] }> {
  const res = await requestJson('/api/workflows/runs/{runId}', 'get', { params: { runId: id } });
  return {
    run: toRun(res.run),
    events: res.events.map(toRunEvent),
    nodes: res.run.nodes,
  };
}

export async function cancelRun(id: string): Promise<void> {
  await requestJson('/api/workflows/runs/{runId}/cancel', 'post', { params: { runId: id } });
}

type RespondWorkflowRunBody = components['schemas']['RespondWorkflowRunBody'];

export async function respondRun(
  id: string,
  decision: string,
  text?: string,
  expectedGate?: RespondWorkflowRunBody['expectedGate']
): Promise<void> {
  const body: RespondWorkflowRunBody = { decision, text, expectedGate };
  await requestJson('/api/workflows/runs/{runId}/respond', 'post', { params: { runId: id }, body });
}

type AnswerWorkflowRunBody = components['schemas']['AnswerWorkflowRunBody'];

/**
 * Answer a paused attention wait in its declared form. `occurrence` is the one the run's
 * attention reports; the server refuses an answer meant for any other pause.
 */
export async function answerRun(
  id: string,
  occurrence: string,
  choose: string[],
  text?: string
): Promise<void> {
  const body: AnswerWorkflowRunBody = { occurrence, choose, text };
  await requestJson('/api/workflows/runs/{runId}/answer', 'post', { params: { runId: id }, body });
}

/** Asks the server to resume a run; resolves to the server's account of what it started. */
export async function resumeRun(id: string): Promise<string> {
  const res = await requestJson('/api/workflows/runs/{runId}/resume', 'post', {
    params: { runId: id },
  });
  return res.message;
}

export async function abandonRun(id: string): Promise<void> {
  await requestJson('/api/workflows/runs/{runId}/abandon', 'post', { params: { runId: id } });
}

/**
 * Re-exported from the generated OpenAPI types so the console doesn't drift
 * from the server contract. Schema lives in
 * packages/server/src/routes/schemas/workflow.schemas.ts.
 */
export type ArtifactFile = components['schemas']['ArtifactFile'];

export async function listRunArtifacts(runId: string): Promise<ArtifactFile[]> {
  const res = await requestJson('/api/runs/{runId}/artifacts', 'get', { params: { runId } });
  return res.files;
}

/** Fetch a single artifact file as text (markdown or plain). */
export async function fetchArtifact(runId: string, path: string): Promise<string> {
  const res = await fetch(
    buildApiUrl('/api/artifacts/{runId}/{filename}', 'get', { params: { runId, filename: path } })
  );
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const error: ArtifactError['error'] | undefined =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : undefined;
    throw new Error(error ?? `Failed to fetch artifact: ${res.status.toString()}`);
  }
  return res.text();
}

type ArtifactError =
  paths['/api/artifacts/{runId}/{filename}']['get']['responses'][400]['content']['application/json'];
