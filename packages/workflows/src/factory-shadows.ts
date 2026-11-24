/**
 * What a pack's shadow steps decided: each completed run of a step the view file declares a
 * shadow (`shadows`), read from the value it recorded. A shadow decides what it would do and
 * does nothing, so a decision here is only ever what it would have done. Nothing here names a
 * pack's step or its value's keys; the declaration says where each value is.
 */
import { z } from 'zod';
import { factoryRunWorkflowName } from './factory-views';
import { resolveJsonPointer } from './json-pointer';
import { nodeResultValue } from './node-result-value';
import type { JsonValue } from './output-ref';
import type { FactoryShadow, FactoryView } from './schemas/factory-view';
import type { WorkflowRun } from './schemas/workflow-run';
import { buildCompletedNodeData, type TerminalRecordEvent } from './terminal-record';

/*
 * A plain union of objects, never `.nullable()` on it: the API's generated types read a
 * nullable union as `unknown` (see `factoryItemRunSchema.cause`).
 */
const shadowReadSchema = z.discriminatedUnion('reads', [
  z.object({
    reads: z.literal('verdict'),
    /** The value at the declared pointer, as the pack recorded it; the view words it. */
    value: z.string(),
    why: z.string().nullable(),
  }),
  z.object({
    reads: z.literal('checks'),
    results: z.array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        seconds: z.number().nullable(),
        tail: z.string().nullable(),
      })
    ),
  }),
  z.object({
    reads: z.literal('lists'),
    /** How many entries each declared list holds, in declared order. */
    counts: z.array(z.number().int().nonnegative()),
    why: z.string().nullable(),
  }),
  /** The step completed, but its value does not read as the declaration says. */
  z.object({ reads: z.literal('unreadable') }),
]);
type FactoryShadowRead = z.infer<typeof shadowReadSchema>;

export const factoryShadowDecisionSchema = z.object({
  /** The workflow and step as the view's `shadows` entry names them. */
  workflow: z.string(),
  node: z.string(),
  /** The loop round it decided in; null for a step outside a loop. */
  round: z.number().int().positive().nullable(),
  runId: z.string(),
  /**
   * When its run completed, else when it was last active, else when it started. It orders
   * decisions across runs; it is not the step's own time.
   */
  decidedAt: z.string().datetime(),
  read: shadowReadSchema,
});
export type FactoryShadowDecision = z.infer<typeof factoryShadowDecisionSchema>;

const UNREADABLE: FactoryShadowRead = { reads: 'unreadable' };

/** A trimmed, non-empty string at `pointer`; null when there is none or no pointer. */
function textAt(value: JsonValue, pointer: string | undefined): string | null {
  if (pointer === undefined) return null;
  const found = resolveJsonPointer(value, pointer);
  return typeof found === 'string' && found.trim() !== '' ? found.trim() : null;
}

type ChecksShadow = Extract<FactoryShadow, { reads: 'checks' }>;
type CheckResult = Extract<FactoryShadowRead, { reads: 'checks' }>['results'][number];

function readCheck(shadow: ChecksShadow, entry: JsonValue): CheckResult | null {
  const name = resolveJsonPointer(entry, shadow.entry.name);
  const passed = resolveJsonPointer(entry, shadow.entry.passed);
  if (typeof name !== 'string' || typeof passed !== 'boolean') return null;
  const seconds =
    shadow.entry.seconds === undefined
      ? undefined
      : resolveJsonPointer(entry, shadow.entry.seconds);
  return {
    name,
    passed,
    seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null,
    tail: textAt(entry, shadow.entry.tail),
  };
}

/** The step's value read as its declaration says; unreadable when it does not read so. */
export function readShadowValue(shadow: FactoryShadow, value: JsonValue): FactoryShadowRead {
  switch (shadow.reads) {
    case 'verdict': {
      const verdict = textAt(value, shadow.pointer);
      return verdict === null
        ? UNREADABLE
        : { reads: 'verdict', value: verdict, why: textAt(value, shadow.why) };
    }
    case 'checks': {
      const results = resolveJsonPointer(value, shadow.results);
      if (!Array.isArray(results)) return UNREADABLE;
      const read = results.map(entry => readCheck(shadow, entry));
      if (read.some(entry => entry === null)) return UNREADABLE;
      return { reads: 'checks', results: read.filter(entry => entry !== null) };
    }
    case 'lists': {
      const lists = shadow.lists.map(list => resolveJsonPointer(value, list.pointer));
      if (!lists.every(Array.isArray)) return UNREADABLE;
      return {
        reads: 'lists',
        counts: lists.map(list => (Array.isArray(list) ? list.length : 0)),
        why: textAt(value, shadow.why),
      };
    }
  }
}

/** A completed step's value; undefined when its text was cut short and nothing else says it. */
function completedValue(data: Record<string, unknown>): JsonValue | undefined {
  if (data.structured_output === undefined && data.node_output_truncated === true) return undefined;
  return nodeResultValue(data.structured_output, data.node_output);
}

/**
 * The decisions the shadows declared on `run`'s workflow recorded in it, one per completed
 * invocation (one per loop round), in recording order. A step that never completed (skipped,
 * failed, not reached) decided nothing and yields none. Never throws on a value it cannot read.
 */
export function shadowDecisions(
  view: FactoryView,
  pack: string,
  run: Pick<
    WorkflowRun,
    'id' | 'metadata' | 'workflow_name' | 'started_at' | 'completed_at' | 'last_activity_at'
  >,
  events: readonly TerminalRecordEvent[]
): FactoryShadowDecision[] {
  // The run's own name, not `declaredWorkflow`: the discoveries workflow is on no stage.
  const shadows = (view.shadows ?? []).filter(
    shadow => factoryRunWorkflowName(pack, shadow.workflow) === run.workflow_name
  );
  if (shadows.length === 0) return [];
  const decidedAt = (run.completed_at ?? run.last_activity_at ?? run.started_at).toISOString();
  return buildCompletedNodeData(run, events).flatMap(completed => {
    const shadow = shadows.find(entry => entry.node === completed.path);
    if (shadow === undefined) return [];
    const value = completedValue(completed.data);
    return [
      {
        workflow: shadow.workflow,
        node: shadow.node,
        round: completed.loopPath.at(-1)?.iteration ?? null,
        runId: run.id,
        decidedAt,
        read: value === undefined ? UNREADABLE : readShadowValue(shadow, value),
      },
    ];
  });
}

/**
 * The newest decision of each shadow across an item's runs, given each run's decisions in run
 * start order: a later run wins, and within a run its last round.
 */
export function latestShadowDecisions(
  perRun: readonly (readonly FactoryShadowDecision[])[]
): FactoryShadowDecision[] {
  const latest = new Map<string, FactoryShadowDecision>();
  for (const decision of perRun.flat()) {
    const key = JSON.stringify([decision.workflow, decision.node]);
    // Delete first, so the map's order is each shadow's newest decision's order.
    latest.delete(key);
    latest.set(key, decision);
  }
  return [...latest.values()];
}
