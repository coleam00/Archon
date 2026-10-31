/**
 * Which model ran each AI step of a run and of the runs below it, read from what the engine
 * recorded on each node's terminal event. No store holds steps: they come from
 * `listEventsForRuns`, and child runs from `listWorkflowRuns({ parentRunIds })`, one tree
 * level per query.
 */
import { z } from 'zod';
import { serializedNodeDataSchema } from './node-record-serialization';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';

export type RunStepsStore = Pick<IWorkflowStore, 'listEventsForRuns' | 'listWorkflowRuns'>;

/** Per run, the latest terminal event of each node, in recorded order. */
export type TerminalEvents = Map<string, WorkflowEventRow[]>;

/** One AI node that completed: the node and the model binding that ran it. */
export interface RunStep {
  nodeId: string;
  /** `provider/model`, plus `@effort` when recorded. */
  label: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  /** The completion recorded no cost. */
  costless: boolean;
}

export interface RunStepIndex {
  /** The AI steps of `runId` and of every run below it. */
  treeSteps(runId: string): RunStep[];
}

const RUN_CHUNK = 500;
const CHILD_PAGE = 500;

/**
 * Read the terminal events of `runIds` not already in `known`, and add them to it. A
 * completion later amended to `node_failed`, or superseded by a re-execution, is not its
 * node's latest terminal event.
 */
export async function readTerminalEvents(
  store: Pick<IWorkflowStore, 'listEventsForRuns'>,
  runIds: readonly string[],
  known: TerminalEvents = new Map()
): Promise<TerminalEvents> {
  const missing = [...new Set(runIds)].filter(id => !known.has(id));
  for (let start = 0; start < missing.length; start += RUN_CHUNK) {
    const chunk = missing.slice(start, start + RUN_CHUNK);
    const byRun = await store.listEventsForRuns(chunk, ['node_completed', 'node_failed']);
    for (const id of chunk) known.set(id, latestPerNode(byRun.get(id) ?? []));
  }
  return known;
}

function latestPerNode(events: readonly WorkflowEventRow[]): WorkflowEventRow[] {
  const lastByNode = new Map<string, WorkflowEventRow>();
  for (const event of events) {
    if (event.step_name !== null) lastByNode.set(event.step_name, event);
  }
  return [...lastByNode.values()];
}

const stepDataSchema = serializedNodeDataSchema
  .pick({ model: true, model_usage: true, cost_usd: true })
  .extend({ provider: z.string(), effort: z.string().optional() });

/**
 * A step's label prefers the model the provider reported over the requested one, so an
 * alias and the model it resolves to share a label.
 */
function stepOf(event: WorkflowEventRow): RunStep | null {
  if (event.event_type !== 'node_completed' || event.step_name === null) return null;
  const parsed = stepDataSchema.safeParse(event.data);
  if (!parsed.success) return null;
  const { provider, model, model_usage, effort, cost_usd } = parsed.data;
  const ran = model_usage?.resolved ?? model;
  return {
    nodeId: event.step_name,
    label: `${provider}${ran === undefined ? '' : `/${ran}`}${effort === undefined ? '' : `@${effort}`}`,
    requestedModel: model ?? null,
    resolvedModel: model_usage?.resolved ?? null,
    costless: cost_usd === undefined,
  };
}

/** Every child run of `parentRunIds`, paged until the store's total. */
async function childRuns(
  store: RunStepsStore,
  parentRunIds: readonly string[]
): Promise<{ id: string; parent: string }[]> {
  const children: { id: string; parent: string }[] = [];
  for (;;) {
    const page = await store.listWorkflowRuns({
      parentRunIds: [...parentRunIds],
      limit: CHILD_PAGE,
      offset: children.length,
    });
    for (const run of page.runs) {
      if (run.parent_run_id !== null) children.push({ id: run.id, parent: run.parent_run_id });
    }
    if (page.runs.length === 0 || children.length >= page.total) return children;
  }
}

/** The child ids of each run below `roots`, walked breadth-first with a visited set. */
async function childrenByParent(
  store: RunStepsStore,
  roots: readonly string[]
): Promise<Map<string, Set<string>>> {
  const children = new Map<string, Set<string>>();
  const visited = new Set(roots);
  let frontier = [...visited];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const { id, parent } of await childRuns(store, frontier)) {
      children.set(parent, (children.get(parent) ?? new Set()).add(id));
      if (visited.has(id)) continue;
      visited.add(id);
      next.push(id);
    }
    frontier = next;
  }
  return children;
}

function treeOf(root: string, children: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const tree = new Set([root]);
  for (const id of tree) {
    for (const child of children.get(id) ?? []) tree.add(child);
  }
  return [...tree];
}

/**
 * Index the AI steps of `roots` and their descendants. Terminal events already in `known`
 * are reused; the rest are read and added to it.
 */
export async function readRunSteps(
  store: RunStepsStore,
  roots: readonly string[],
  known: TerminalEvents
): Promise<RunStepIndex> {
  const children = await childrenByParent(store, roots);
  const runIds = [...new Set([...roots, ...[...children.values()].flatMap(ids => [...ids])])];
  await readTerminalEvents(store, runIds, known);
  const steps = new Map(
    runIds.map(id => [id, (known.get(id) ?? []).flatMap(event => stepOf(event) ?? [])])
  );
  return {
    treeSteps: runId => treeOf(runId, children).flatMap(id => steps.get(id) ?? []),
  };
}
