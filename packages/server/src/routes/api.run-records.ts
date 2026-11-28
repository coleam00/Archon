/**
 * `GET /api/workflows/runs/records`: the records of many runs in one read, without their
 * events. The run detail route returns a run's whole event list (several MB for a long run);
 * a reader that needs only where each of a few hundred runs stands and what it recorded would
 * otherwise read every list. Read-only.
 */
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import {
  projectRunRecord,
  RUN_RECORD_EVENT_TYPES,
  runRecord,
  type RunRecord,
} from '@archon/workflows/run-records';
import { isTerminalRunStatus } from '@archon/workflows/schemas/run-status';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  apiError,
  getLog,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { runRecordsQuerySchema, runRecordsResponseSchema } from './schemas/workflow.schemas';

const getRunRecordsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/records',
  tags: ['Workflows'],
  summary: 'The records of several runs, without their events',
  description:
    "For each run asked (`runId`, repeated, at most 100): its status, the terminal record's `returns`, every node invocation with a completed node's structured output (as `$NODE_OUTCOMES_FILE` lists them), each loop iteration it started with its bound and whether it completed, and the steps running now. `outputKey` and `resultKey` keep only the named top-level fields of each output and of the result. An id no run has is listed under `missing`; a run whose events do not fold is listed under `unreadable` and the others still read.",
  request: { query: runRecordsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: runRecordsResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Invalid query'),
    500: jsonError('Server error'),
  },
});

export interface RunRecordsDeps {
  runsByIds: (ids: readonly string[]) => Promise<WorkflowRun[]>;
  eventsForRuns: (ids: readonly string[]) => Promise<Map<string, WorkflowEventRow[]>>;
}

const DEFAULT_DEPS: RunRecordsDeps = {
  runsByIds: ids => workflowDb.getWorkflowRunsByIds(ids),
  eventsForRuns: ids => workflowEventDb.listEventsForRuns(ids, RUN_RECORD_EVENT_TYPES),
};

/** How many ended runs' records the process keeps; about a large project's every run. */
const MEMO_LIMIT = 2_000;

/**
 * Ended runs' records, kept across reads, so a reread folds events only for runs still going.
 * Keyed by status and end time too: a failed run can be resumed and end again. The least
 * recently read entry goes first.
 */
class EndedRunMemo {
  private readonly entries = new Map<string, RunRecord>();

  static key(run: WorkflowRun): string | null {
    if (!isTerminalRunStatus(run.status)) return null;
    return `${run.id}|${run.status}|${run.completed_at?.toISOString() ?? ''}`;
  }

  get(run: WorkflowRun): RunRecord | undefined {
    const key = EndedRunMemo.key(run);
    const record = key === null ? undefined : this.entries.get(key);
    if (key !== null && record !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, record);
    }
    return record;
  }

  set(run: WorkflowRun, record: RunRecord): void {
    const key = EndedRunMemo.key(run);
    if (key === null) return;
    this.entries.set(key, record);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MEMO_LIMIT) break;
      this.entries.delete(oldest);
    }
  }
}

export function registerRunRecordsRoute(
  app: OpenAPIHono,
  deps: RunRecordsDeps = DEFAULT_DEPS
): void {
  const register = openApiRouteRegistrar(app);
  const memo = new EndedRunMemo();

  register(getRunRecordsRoute, async c => {
    const query = getValidatedQuery(c, runRecordsQuerySchema);
    const listOf = (value: string | string[] | undefined): string[] | undefined =>
      value === undefined ? undefined : typeof value === 'string' ? [value] : value;
    const ids = [...new Set(listOf(query.runId))];
    const project = (record: RunRecord): RunRecord =>
      projectRunRecord(record, listOf(query.outputKey), listOf(query.resultKey));
    try {
      const runs = new Map((await deps.runsByIds(ids)).map(run => [run.id, run]));
      const load = [...runs.values()].filter(run => memo.get(run) === undefined);
      const events = load.length === 0 ? new Map() : await deps.eventsForRuns(load.map(r => r.id));
      const records: RunRecord[] = [];
      const missing: string[] = [];
      const unreadable: { id: string; error: string }[] = [];
      for (const id of ids) {
        const run = runs.get(id);
        if (run === undefined) {
          missing.push(id);
          continue;
        }
        const kept = memo.get(run);
        if (kept !== undefined) {
          records.push(project(kept));
          continue;
        }
        // bun:sqlite answers synchronously and a fold is CPU work: give other requests a
        // turn between runs, as the item reads do.
        await new Promise<void>(resolve => setImmediate(resolve));
        try {
          const record = runRecord(run, events.get(id) ?? []);
          memo.set(run, record);
          records.push(project(record));
        } catch (error) {
          getLog().warn({ err: error, runId: id }, 'run_record_unreadable');
          unreadable.push({ id, error: (error as Error).message });
        }
      }
      return c.json({ records, missing, unreadable });
    } catch (error) {
      getLog().error({ err: error }, 'run_records_read_failed');
      return apiError(c, 500, 'Failed to read the run records');
    }
  });
}
