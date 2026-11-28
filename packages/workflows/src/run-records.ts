/**
 * A run's record without its events: what a reader needs to tell where a run is and what it
 * recorded, for many runs in one request. Everything here is derived from the run's own events
 * by the engine's folds (`buildNodeOutcomes`, `getTerminalRecord`, `foldActiveNodeIds`); a
 * reader that wants the events themselves reads `GET /api/workflows/runs/{runId}`.
 */
import { z } from 'zod';
import { nodeOutcomesListingSchema } from './schemas/node-outcomes';
import { workflowRunStatusSchema } from './schemas/run-status';
import { terminalRecordSchema } from './schemas/terminal-record';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { WorkflowRun } from './schemas/workflow-run';
import {
  foldActiveNodeIds,
  NODE_STATE_EVENT_TYPES,
  type NodeStateEventType,
  type WorkflowEventType,
} from './store/event-types';
import { buildNodeOutcomes, getTerminalRecord } from './terminal-record';

/** The most runs one records read names (`GET /api/workflows/runs/records`). */
export const RUN_RECORDS_MAX = 100;

/** The event types `runRecord` reads: node state, loop iterations and the terminal events. */
export const RUN_RECORD_EVENT_TYPES: readonly WorkflowEventType[] = [
  ...NODE_STATE_EVENT_TYPES,
  'loop_iteration_started',
  'loop_iteration_completed',
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
];

export const runRecordSchema = z.object({
  id: z.string(),
  status: workflowRunStatusSchema,
  /** Null while the run has not ended. */
  completed_at: z.string().datetime().nullable(),
  /**
   * The terminal record's `returns`; absent when the run has no terminal record. Optional
   * rather than nullable, so generated API types keep its variants.
   */
  returns: terminalRecordSchema.shape.returns.optional(),
  /** Every node invocation the run recorded, with a completed node's structured output. */
  node_outcomes: nodeOutcomesListingSchema,
  /**
   * Each iteration a loop started, in the order started: the loop's step (`group`), its
   * number, the bound it started under (null when none was recorded) and whether it completed.
   */
  loop_iterations: z.array(
    z.object({
      group: z.string(),
      iteration: z.number().int().positive(),
      max: z.number().int().positive().nullable(),
      completed: z.boolean(),
    })
  ),
  /** The steps running now, in the order they started; empty once the run ended. */
  running: z.array(z.string()),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

const loopRowSchema = z.object({
  iteration: z.number().int().positive(),
  maxIterations: z.number().int().positive().optional(),
});

function loopIterations(events: readonly WorkflowEventRow[]): RunRecord['loop_iterations'] {
  const started = new Map<string, RunRecord['loop_iterations'][number]>();
  for (const row of events) {
    if (row.step_name === null) continue;
    const parsed = loopRowSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const key = `${row.step_name}#${String(parsed.data.iteration)}`;
    if (row.event_type === 'loop_iteration_started')
      started.set(key, {
        group: row.step_name,
        iteration: parsed.data.iteration,
        max: parsed.data.maxIterations ?? null,
        completed: false,
      });
    else if (row.event_type === 'loop_iteration_completed') {
      const entry = started.get(key);
      if (entry !== undefined) entry.completed = true;
    }
  }
  return [...started.values()];
}

const NODE_STATE_TYPES: ReadonlySet<string> = new Set(NODE_STATE_EVENT_TYPES);

/** The steps running at the end of `events`, by the dashboard's fold, in the order each last started. */
function runningSteps(events: readonly WorkflowEventRow[]): string[] {
  const active = new Set<string>();
  const startedAt = new Map<string, number>();
  for (const [index, row] of events.entries()) {
    if (!NODE_STATE_TYPES.has(row.event_type)) continue;
    foldActiveNodeIds(active, row.step_name, row.event_type as NodeStateEventType);
    if (row.event_type === 'node_started' && row.step_name)
      startedAt.set(row.step_name, row.event_order ?? index);
  }
  return [...active].sort((a, b) => (startedAt.get(a) ?? -1) - (startedAt.get(b) ?? -1));
}

/** The record of `run` from its events of `RUN_RECORD_EVENT_TYPES`, in append order. */
export function runRecord(run: WorkflowRun, events: readonly WorkflowEventRow[]): RunRecord {
  const returns = getTerminalRecord(run.status, events)?.returns;
  return {
    id: run.id,
    status: run.status,
    completed_at: run.completed_at?.toISOString() ?? null,
    ...(returns === undefined ? {} : { returns }),
    node_outcomes: buildNodeOutcomes(run, events),
    loop_iterations: loopIterations(events),
    running: run.status === 'running' ? runningSteps(events) : [],
  };
}

/** `value` with only the top-level fields `keys` names, when it is an object; else as it is. */
function keepFields(value: unknown, keys: ReadonlySet<string>): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)));
}

/**
 * `record` with each node's structured output kept to the top-level fields `outputKeys` names,
 * and its result to those `resultKeys` names; a list left undefined keeps that part whole. A
 * reader that needs a few fields of many runs asks for them and reads a fraction of the bytes.
 */
export function projectRunRecord(
  record: RunRecord,
  outputKeys: readonly string[] | undefined,
  resultKeys: readonly string[] | undefined
): RunRecord {
  const outputs = outputKeys === undefined ? null : new Set(outputKeys);
  const results = resultKeys === undefined ? null : new Set(resultKeys);
  const returns =
    results !== null && record.returns?.availability === 'available'
      ? { ...record.returns, value: keepFields(record.returns.value, results) }
      : record.returns;
  return {
    ...record,
    ...(returns === undefined ? {} : { returns }),
    node_outcomes:
      outputs === null
        ? record.node_outcomes
        : {
            ...record.node_outcomes,
            nodes: record.node_outcomes.nodes.map(node =>
              node.output === undefined
                ? node
                : { ...node, output: keepFields(node.output, outputs) }
            ),
          },
  };
}
