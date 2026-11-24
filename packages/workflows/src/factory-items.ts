/**
 * What a factory view reads of a project's items beyond the engine's item read (`ItemRead`,
 * as `GET /api/items/window` pages it): each item's progress on the board. Progress is
 * derived from the engine's own records through the view's declaration (`rounds`,
 * `returns`, `change`, `itemTitle`); nothing here stores a position or names a pack's steps.
 *
 * The derivation is pure (`factoryRunFacts`, `factoryItemProgress`); `readFactoryProgress`
 * reads the store once for a set of items and feeds them, and `readFactoryItem` reads one
 * item whole, adding what its page tells of each run (`FactoryItemRun`). Whether a change merged,
 * and which pull request a run that named no URL delivered, is the caller's lookup
 * (`changeState`), since only the server reaches the forge.
 */
import { z } from 'zod';
import { factoryRunWorkflowName } from './factory-views';
import {
  assembleItemReads,
  itemReadSchema,
  readItemQueue,
  readItemRuns,
  type ItemReadSource,
} from './item-read';
import { factoryAwaitsSchema, resultString, runAwaits, runParked } from './factory-parked';
import type { FactoryView } from './schemas/factory-view';
import { readSubrunMetadata } from './schemas/run-metadata';
import { startCauseSchema } from './schemas/resource-start';
import { parseRunUsage } from './schemas/run-usage';
import { isTerminalRunStatus } from './schemas/run-status';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { displayedRunOutcome, type WorkflowRun } from './schemas/workflow-run';
import {
  foldActiveNodeIds,
  NODE_STATE_EVENT_TYPES,
  type NodeStateEventType,
  type WorkflowEventType,
} from './store/event-types';
import { buildNodeOutcomes } from './terminal-record';
import {
  changeOf,
  runChange,
  type FactoryChangeRecord,
  type FactoryChangeState,
} from './factory-change';
export type {
  FactoryChangeLookup,
  FactoryChangeRecord,
  FactoryChangeState,
} from './factory-change';
import { factoryRunStoryShape, runStories } from './factory-item-story';
import { decidedIn, itemRound, runRounds, type DecisionPoint } from './factory-rounds';
import {
  factoryShadowDecisionSchema,
  latestShadowDecisions,
  shadowDecisions,
  type FactoryShadowDecision,
} from './factory-shadows';

/**
 * How one declared check round ended (an iteration of a loop-form rounds source, or one run
 * of a stage-form source, numbered by its result), from declared data only: `returned` when
 * a declared return point in the loop sent the item back that round, `approved` when a
 * declared approval point approved it, `undecided` when the round completed with neither
 * (an ask, a replan, or a view that declares no approval: the round's `outcome` says
 * which), `running` while it goes on, `stopped` when the run ended inside it.
 */
export const factoryRoundVerdictSchema = z.enum([
  'approved',
  'returned',
  'undecided',
  'running',
  'stopped',
]);
export type FactoryRoundVerdict = z.infer<typeof factoryRoundVerdictSchema>;

/**
 * Whether the change merged: `true` when the engine recorded the item's merge (the change
 * host is then not asked whether it merged), else as the change host reported it: `unknown` when it could not
 * say, `pending` while the server is still asking it (read again shortly; the answer is
 * never cached).
 */
const factoryChangeMergedSchema = z.union([
  z.boolean(),
  z.literal('unknown'),
  z.literal('pending'),
]);
export type FactoryChangeMerged = z.infer<typeof factoryChangeMergedSchema>;

const factoryItemProgressSchema = z.object({
  /**
   * The declared run input's title line, after any front matter, without a leading `#<n> ` or
   * heading marker; null when no run carries one.
   */
  title: z.string().nullable(),
  /** The latest-started running run of a declared workflow; null when none runs. */
  running: z
    .object({
      runId: z.string(),
      /** The workflow as the view declares it, not as the run records it. */
      workflow: z.string(),
      /** The deepest running step; null between steps. */
      step: z.string().nullable(),
      startedAt: z.string().datetime(),
    })
    .nullable(),
  /**
   * The item's check rounds, from the declared rounds source whose workflow recorded a round
   * on the item most recently. Loop form: the loop on the latest run that entered it. Stage
   * form: each run of the workflow is one round, from its own result; the rounds since the
   * item was last planned, and `runId` the newest of them. A stage-form run still going has
   * no round yet, so it is not here.
   */
  round: z
    .object({
      runId: z.string(),
      iteration: z.number().int().positive(),
      /**
       * The loop's bound as its latest round recorded it, or the newest stage-form run's
       * allowance; null when it recorded none.
       */
      max: z.number().int().positive().nullable(),
      rounds: z.array(
        z.object({
          iteration: z.number().int().positive(),
          verdict: factoryRoundVerdictSchema,
          /**
           * The outcome the loop's declared return or approval step recorded that round, as
           * the workflow names it (`return`, `approve`, `ask`...); null when it recorded none.
           */
          outcome: z.string().nullable(),
        })
      ),
    })
    .nullable(),
  /**
   * The work order (an item key) the latest run of the declared `partOf` workflow that
   * completed with the declared outcome names at its pointer, as written; null when there is
   * no such run or it names none there.
   * An item's active `part_of` link wins over this; the reader decides.
   */
  partOf: z.string().nullable(),
  /** How many times a declared return point sent the item back, across all its runs. */
  returned: z.number().int().nonnegative(),
  /**
   * The change at a declared result pointer of the latest run that names one, of any workflow
   * `change` lists. When no run names one but a run of a listed workflow delivered with an
   * empty URL there, the pull request the change host finds on the item's run branches.
   */
  change: z
    .object({
      /**
       * The change's URL; null only while the change host has not named the pull request of
       * a run that named no URL (`pending`, or `unknown`).
       */
      url: z.string().nullable(),
      merged: factoryChangeMergedSchema,
      mergedAt: z.string().nullable(),
      /** The pull request's number, as the forge or the run's audit rows name it; null when none does. */
      number: z.number().int().positive().nullable(),
    })
    .nullable(),
  /**
   * The item's runs of declared workflows, in start order, each with the workflow as the
   * view declares it (a run records `owner/name:workflow`). Status, outcome and times are
   * on the item read's `runs`, joined by id.
   */
  runs: z.array(
    z.object({
      runId: z.string(),
      workflow: z.string(),
      /** The first step that failed, as the run's terminal record names it; null when none. */
      failedStep: z.string().nullable(),
    })
  ),
  /**
   * The newest decision of each shadow step the view declares (`shadows`) across the item's
   * runs, a run of the discoveries workflow included; empty when none decided.
   */
  shadows: z.array(factoryShadowDecisionSchema),
  /**
   * When the item's last declared run completed with an outcome the view declares `parked`
   * (kept open for later, not ended): the declared label, and the reason at its `why` pointer
   * in that run's result (null when it declares none or the result has no string there).
   * Null otherwise; `placement` still decides where the item sits.
   */
  parked: z.object({ label: z.string(), why: z.string().nullable() }).nullable(),
  /**
   * As `parked`, for an outcome the view declares `awaits` (open, waiting on a person with no
   * ask open), with the questions at its `questions` pointer (empty when there are none) and
   * the declared `next` sentence (null when none).
   */
  awaits: factoryAwaitsSchema.nullable(),
});
export type FactoryItemProgress = z.infer<typeof factoryItemProgressSchema>;

/**
 * One declared check round on one run (a loop-form source's iteration, or a stage-form
 * source's run, which is one round), with what its steps recorded. `outcome`
 * and `summary` are the declared return or approval step's that decided the round; `steps` are the
 * loop's steps that completed that round with a structured `outcome`, in recording order.
 * `outcome` and `summary` are read by name from a step's structured output, as the workflow
 * names them; a `summary` that is not a string is null.
 */
export const factoryRoundSchema = z.object({
  iteration: z.number().int().positive(),
  verdict: factoryRoundVerdictSchema,
  outcome: z.string().nullable(),
  summary: z.string().nullable(),
  steps: z.array(
    z.object({ node: z.string(), outcome: z.string(), summary: z.string().nullable() })
  ),
});
export type FactoryRound = z.infer<typeof factoryRoundSchema>;

const factoryItemSchema = itemReadSchema.extend({
  /** Null when this item's progress could not be derived; the rest of the read stands. */
  progress: factoryItemProgressSchema.nullable(),
});
export type FactoryItem = z.infer<typeof factoryItemSchema>;

/** What one run of a declared workflow contributes to its item's progress. */
export interface FactoryRunFacts {
  /** The deepest running step, as of the run's events; null when none runs. */
  active: string | null;
  /**
   * The declared check rounds on this run: a loop-form source's iterations, or a stage-form
   * source's one round; null when no source names the run's workflow, or a stage-form run
   * recorded no round.
   */
  rounds: {
    max: number | null;
    rounds: FactoryRound[];
  } | null;
  returnCount: number;
  /** The first step that failed, as the run's terminal record names it; null when none did. */
  failedStep: string | null;
  /**
   * The change at the declared pointer, trimmed, with the run's forge audit rows; null when
   * the run has no string there. A null `url` is an empty or whitespace string: the run
   * delivered but named no URL.
   */
  change: { url: string | null; audits: unknown[] } | null;
  /**
   * The work order at the declared `partOf` pointer, trimmed; null when the run is not of that
   * workflow, did not complete with a result, or names none there (empty or not a string).
   */
  partOf: string | null;
  /** What the run says when it parked its item (`runParked`); else null. */
  parked: FactoryItemProgress['parked'];
  /** What the run says when it left its item waiting on a person (`runAwaits`); else null. */
  awaits: FactoryItemProgress['awaits'];
  /** What the shadow steps the view declares decided on this run, in recording order. */
  shadows: FactoryShadowDecision[];
}

/** The event types `factoryRunFacts` reads. */
const FACTORY_RUN_FACT_EVENT_TYPES: readonly WorkflowEventType[] = [
  ...NODE_STATE_EVENT_TYPES,
  'loop_iteration_started',
  'loop_iteration_completed',
  'workflow_completed',
  'integration_operation',
];

/** The workflow a view declares that a run of `recorded` (as runs record it) is; null when none. */
export function declaredWorkflow(view: FactoryView, pack: string, recorded: string): string | null {
  for (const stage of view.stages)
    for (const workflow of stage.workflows)
      if (factoryRunWorkflowName(pack, workflow) === recorded) return workflow;
  return null;
}

const NODE_STATE_TYPES: ReadonlySet<string> = new Set(NODE_STATE_EVENT_TYPES);

/**
 * The deepest step running: the dashboard's fold over node state, then the step with the
 * most `.`-separated segments (a loop body inside its group), ties to the latest started,
 * then by id.
 */
function deepestActiveStep(events: readonly WorkflowEventRow[]): string | null {
  const active = new Set<string>();
  const startedAt = new Map<string, number>();
  for (const [index, row] of events.entries()) {
    if (!NODE_STATE_TYPES.has(row.event_type)) continue;
    foldActiveNodeIds(active, row.step_name, row.event_type as NodeStateEventType);
    if (row.event_type === 'node_started' && row.step_name)
      startedAt.set(row.step_name, row.event_order ?? index);
  }
  const depth = (step: string): number => step.split('.').length;
  const [deepest] = [...active].sort(
    (a, b) =>
      depth(b) - depth(a) ||
      (startedAt.get(b) ?? -1) - (startedAt.get(a) ?? -1) ||
      a.localeCompare(b)
  );
  return deepest ?? null;
}

/**
 * Whether `run` is one the item's facts read: a run of a workflow a stage lists, or of one a
 * shadow names (the discoveries workflow, which no stage lists).
 */
function factsRead(view: FactoryView, pack: string, run: WorkflowRun): boolean {
  return (
    declaredWorkflow(view, pack, run.workflow_name) !== null ||
    (view.shadows ?? []).some(
      shadow => factoryRunWorkflowName(pack, shadow.workflow) === run.workflow_name
    )
  );
}

/**
 * What one run of a workflow `view` declares, or a shadow names, contributes to its item's
 * progress, from the run's events (`FACTORY_RUN_FACT_EVENT_TYPES`, in append order).
 */
export function factoryRunFacts(
  view: FactoryView,
  pack: string,
  run: WorkflowRun,
  events: readonly WorkflowEventRow[]
): FactoryRunFacts {
  const workflow = declaredWorkflow(view, pack, run.workflow_name);
  const ofWorkflow = (list: readonly DecisionPoint[] | undefined): DecisionPoint[] =>
    (list ?? []).filter(point => point.workflow === workflow);
  const points = { returns: ofWorkflow(view.returns), approves: ofWorkflow(view.approves) };
  const listing = buildNodeOutcomes(run, events);
  const outcomes = listing.nodes;
  return {
    active: deepestActiveStep(events),
    rounds: runRounds(view, workflow, points, run, events, outcomes),
    returnCount: points.returns.reduce((sum, point) => sum + decidedIn(outcomes, point).length, 0),
    failedStep: listing.first_failed_node,
    change: runChange(view, workflow, run, events),
    partOf:
      view.partOf !== undefined && view.partOf.workflow === workflow
        ? resultString(view.partOf.pointer, run, events)
        : null,
    parked: runParked(view, workflow, run, events),
    awaits: runAwaits(view, workflow, run, events),
    shadows: shadowDecisions(view, pack, run, events),
  };
}

/** The title of the newest declared run whose declared input has one. */
export function itemTitle(view: FactoryView, runs: readonly WorkflowRun[]): string | null {
  if (view.itemTitle === undefined) return null;
  for (const run of [...runs].reverse()) {
    const value = readSubrunMetadata(run.metadata).inputs?.[view.itemTitle.input];
    if (typeof value !== 'string') continue;
    const title = titleOfItemText(value);
    if (title !== null) return title;
  }
  return null;
}

/**
 * An item text's title line: the first non-empty line after any `---` front matter, without a
 * leading `#<n> ` or markdown heading marker. An item an order made opens with front matter
 * (`id`, `source`), then `# Title`; an older item opens with `#<n> Title`. Null when there is
 * no such line, including an unterminated front matter, so the board never shows `---`.
 */
export function titleOfItemText(text: string): string | null {
  let lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close === -1) return null;
    lines = lines.slice(close + 1);
  }
  const line = lines.find(candidate => candidate.trim() !== '');
  if (line === undefined) return null;
  const title = line
    .trim()
    .replace(/^#\d+ /, '')
    .replace(/^#{1,6}(\s+|$)/, '')
    .trim();
  return title === '' ? null : title;
}

/**
 * An item's progress from its runs (start order) and the facts of each run read. Only runs of
 * a workflow a stage lists place the item; a run only a shadow names adds its decisions.
 */
export async function factoryItemProgress(
  view: FactoryView,
  pack: string,
  runs: readonly WorkflowRun[],
  facts: ReadonlyMap<string, FactoryRunFacts>,
  changeState: FactoryChangeState,
  /** The branch a run recorded; null when it recorded none. */
  branchOf: (run: WorkflowRun) => Promise<string | null>,
  /** The merge the engine recorded on the item; null when none is, or its row is unreadable. */
  recorded: FactoryChangeRecord | null
): Promise<FactoryItemProgress> {
  const read = [...runs]
    .filter(run => facts.has(run.id))
    .sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
  const declared = read.filter(run => declaredWorkflow(view, pack, run.workflow_name) !== null);
  const last = declared.at(-1);
  const latest = <T>(pick: (run: WorkflowRun, fact: FactoryRunFacts) => T | null): T | null => {
    for (const run of [...declared].reverse()) {
      const fact = facts.get(run.id);
      const value = fact === undefined ? null : pick(run, fact);
      if (value !== null) return value;
    }
    return null;
  };
  const running = latest((run, fact) =>
    run.status === 'running'
      ? {
          runId: run.id,
          workflow: declaredWorkflow(view, pack, run.workflow_name) ?? run.workflow_name,
          step: fact.active,
          startedAt: run.started_at.toISOString(),
        }
      : null
  );
  return {
    title: itemTitle(view, runs),
    running,
    round: itemRound(view, declared, facts, run => declaredWorkflow(view, pack, run.workflow_name)),
    partOf: workOrderOf(view, pack, declared, facts),
    returned: declared.reduce((sum, run) => sum + (facts.get(run.id)?.returnCount ?? 0), 0),
    change: await changeOf(declared, latest, changeState, branchOf, recorded),
    runs: declared.map(run => ({
      runId: run.id,
      workflow: declaredWorkflow(view, pack, run.workflow_name) ?? run.workflow_name,
      failedStep: facts.get(run.id)?.failedStep ?? null,
    })),
    shadows: latestShadowDecisions(read.map(run => facts.get(run.id)?.shadows ?? [])),
    // Placement reads the same last run: one started after the parking one takes the item up.
    parked: (last === undefined ? null : facts.get(last.id)?.parked) ?? null,
    awaits: (last === undefined ? null : facts.get(last.id)?.awaits) ?? null,
  };
}

/**
 * The work order the newest run of the declared `partOf` workflow that completed with the
 * declared outcome names. A run that completed with another outcome (a refusal) is not read.
 * Not `latest()`: an empty value on the newest such run means the item is in no order now,
 * not that an older run's order still holds.
 */
function workOrderOf(
  view: FactoryView,
  pack: string,
  declared: readonly WorkflowRun[],
  facts: ReadonlyMap<string, FactoryRunFacts>
): string | null {
  if (view.partOf === undefined) return null;
  const { workflow, outcome } = view.partOf;
  const newest = [...declared]
    .reverse()
    .find(
      run =>
        run.status === 'completed' &&
        displayedRunOutcome(run) === outcome &&
        declaredWorkflow(view, pack, run.workflow_name) === workflow
    );
  return newest === undefined ? null : (facts.get(newest.id)?.partOf ?? null);
}

/**
 * Facts of runs that ended, kept across reads so a refetch loads events only for
 * runs still going. Keyed by status and end time too, since a failed run can be resumed
 * and end again, and by the declaration parts the facts read, since a view is re-read on
 * every request and may have changed. Bounded; the oldest entry goes first.
 */
export class FactoryRunFactsMemo {
  private readonly entries = new Map<string, FactoryRunFacts>();
  constructor(private readonly limit = 1000) {}

  private static key(view: FactoryView, pack: string, run: WorkflowRun): string | null {
    if (!isTerminalRunStatus(run.status)) return null;
    const read = {
      pack,
      workflows: view.stages.map(stage => stage.workflows),
      rounds: view.rounds,
      returns: view.returns,
      approves: view.approves,
      change: view.change,
      partOf: view.partOf,
      parked: view.parked,
      awaits: view.awaits,
      shadows: view.shadows,
    };
    return `${run.id}|${run.status}|${run.completed_at?.toISOString() ?? ''}|${JSON.stringify(read)}`;
  }

  get(view: FactoryView, pack: string, run: WorkflowRun): FactoryRunFacts | undefined {
    const key = FactoryRunFactsMemo.key(view, pack, run);
    return key === null ? undefined : this.entries.get(key);
  }

  set(view: FactoryView, pack: string, run: WorkflowRun, facts: FactoryRunFacts): void {
    const key = FactoryRunFactsMemo.key(view, pack, run);
    if (key === null) return;
    this.entries.set(key, facts);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
  }
}

/** What reading items for a view needs, whether the progress of several or one item whole. */
interface ReadFactoryItemsInput {
  view: FactoryView;
  pack: string;
  projectKey: string;
  changeState: FactoryChangeState;
  memo: FactoryRunFactsMemo;
  /** Called when one item's progress could not be derived; that item gets `progress: null`. */
  onProgressError: (itemId: string, error: unknown) => void;
}

type FoundItem = NonNullable<Awaited<ReturnType<typeof readItemRuns>>>;

/** Facts for every run of `found` the facts read, loading events only for runs not memoised. */
async function runFactsFor(
  source: ItemReadSource,
  input: ReadFactoryItemsInput,
  found: readonly FoundItem[]
): Promise<Map<string, FactoryRunFacts>> {
  const { view, pack, memo } = input;
  const facts = new Map<string, FactoryRunFacts>();
  const load: WorkflowRun[] = [];
  for (const run of found.flatMap(item => item.runs)) {
    if (!factsRead(view, pack, run)) continue;
    const memoised = memo.get(view, pack, run);
    if (memoised === undefined) load.push(run);
    else facts.set(run.id, memoised);
  }
  if (load.length === 0) return facts;
  const events = await source.store.listEventsForRuns(
    load.map(run => run.id),
    FACTORY_RUN_FACT_EVENT_TYPES
  );
  for (const run of load) {
    try {
      const fact = factoryRunFacts(view, pack, run, events.get(run.id) ?? []);
      facts.set(run.id, fact);
      memo.set(view, pack, run, fact);
    } catch (error) {
      // Left out of `facts`; the item reports it through `onProgressError`.
      input.onProgressError(run.item_id ?? run.id, error);
    }
  }
  return facts;
}

/**
 * The factory reads of the items `readItemRuns` found, against one read of the attention
 * queue, with the facts of their declared runs.
 */
async function readFoundItems(
  source: ItemReadSource,
  input: ReadFactoryItemsInput,
  found: readonly FoundItem[]
): Promise<{ items: FactoryItem[]; facts: ReadonlyMap<string, FactoryRunFacts> }> {
  // The one queue reader, read once for all of them.
  const queue = await readItemQueue(source);
  const facts = await runFactsFor(source, input, found);
  const reads = await assembleItemReads(
    source,
    found.map(item => item.item),
    queue
  );
  const read = await Promise.all(
    found.map(async (item, index): Promise<FactoryItem | null> => {
      const itemRead = reads[index] ?? null;
      // An item gone from the store since it was found is no longer the project's.
      if (itemRead === null) return null;
      return { ...itemRead, progress: await itemProgress(source, input, item, facts) };
    })
  );
  return { items: read.filter((item): item is FactoryItem => item !== null), facts };
}

export const factoryProgressSchema = z.object({
  /** The pack whose view the progress was derived with. */
  pack: z.string(),
  /**
   * Each asked item's progress, by key; null when it could not be derived. A key the
   * project has no item under is left out.
   */
  progress: z.record(z.string(), factoryItemProgressSchema.nullable()),
  /**
   * For each asked item, by key, the keys of the items with an active `part_of` link to it
   * (its work order's members), in recording order; an item with none has an empty list. Apart
   * from `progress`, so an item whose progress could not be derived still lists its members,
   * and read for an item with no runs too. A key the project has no item under is left out.
   */
  members: z.record(z.string(), z.array(z.string())),
});
export type FactoryProgress = z.infer<typeof factoryProgressSchema>;

/**
 * The progress of the items `keys` name, reading their runs and the facts of their declared
 * runs once for all of them. The item reads themselves are the engine's window's.
 */
export async function readFactoryProgress(
  source: ItemReadSource,
  input: ReadFactoryItemsInput,
  keys: readonly string[]
): Promise<FactoryProgress> {
  const found: FoundItem[] = [];
  for (const key of new Set(keys)) {
    const item = await readItemRuns(source.store, input.projectKey, key);
    if (item !== null) found.push(item);
  }
  const facts = await runFactsFor(source, input, found);
  // Together: each may wait on the change host for a merge state no request has read yet.
  const read = await Promise.all(
    found.map(
      async item => [item.item.key, await itemProgress(source, input, item, facts)] as const
    )
  );
  const members = await Promise.all(
    found.map(async item => [item.item.key, await memberKeys(source, item.item.id)] as const)
  );
  return {
    pack: input.pack,
    progress: Object.fromEntries(read),
    members: Object.fromEntries(members),
  };
}

/** The keys of the items with an active `part_of` link to the item `itemId`, in recording order. */
async function memberKeys(source: ItemReadSource, itemId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const link of await source.store.listItemLinks(itemId)) {
    // A link row that does not read has no kind to go by. The order's own item read lists
    // it under `degraded`, which its item page shows; here it is no member.
    if ('type' in link) continue;
    if (link.kind === 'part_of' && link.ended === null && link.to.id === itemId)
      keys.push(link.from.key);
  }
  return keys;
}

/**
 * What the item page tells of one of an item's runs beyond the item read's run: the workflow
 * as the view declares it, its cost, its running step, and the declared rounds loop's rounds
 * on it with each round's steps.
 */
export const factoryItemRunSchema = z.object({
  runId: z.string(),
  /** The workflow as the view names it (a stage's or its `discoveries` drain); else null. */
  workflow: z.string().nullable(),
  /**
   * What started the run, as `item.runs[].cause` reads it; absent for a start by hand. The
   * same value, repeated here because the API's generated types read a nullable union as
   * `unknown`, and an optional one keeps its variants for the console.
   */
  cause: startCauseSchema.optional(),
  /** The run's total cost as it recorded it; null until it records one. */
  costUsd: z.number().nullable(),
  /** The deepest running step while the run runs; null between steps and once it ended. */
  step: z.string().nullable(),
  /**
   * What the shadow steps the view declares decided on this run, in recording order; empty
   * when none did, or its facts could not be read.
   */
  shadows: z.array(factoryShadowDecisionSchema),
  /** Null when the run is not of the rounds loop's workflow, or its facts could not be read. */
  rounds: z
    .object({
      max: z.number().int().positive().nullable(),
      rounds: z.array(factoryRoundSchema),
    })
    .nullable(),
  /**
   * The pull request this run named at the view's `change` pointer, trimmed; null when it
   * named none (or an empty one), or its facts could not be read.
   */
  change: z.string().nullable(),
  ...factoryRunStoryShape,
});
type FactoryItemRun = z.infer<typeof factoryItemRunSchema>;

export const factoryItemDetailSchema = z.object({
  /** The pack whose view the progress was derived with. */
  pack: z.string(),
  item: factoryItemSchema,
  /** One entry per run in `item.runs`, in the same order. */
  runs: z.array(factoryItemRunSchema),
});
export type FactoryItemDetail = z.infer<typeof factoryItemDetailSchema>;

/** The item `key` names, its read and progress, with each run's story facts. */
export async function readFactoryItem(
  source: ItemReadSource,
  input: ReadFactoryItemsInput,
  key: string
): Promise<FactoryItemDetail | null> {
  const found = await readItemRuns(source.store, input.projectKey, key);
  if (found === null) return null;
  const { items, facts } = await readFoundItems(source, input, [found]);
  const [item] = items;
  if (item === undefined) return null;
  const causes = new Map(item.runs.map(run => [run.id, run.cause]));
  const stories = await runStories(source, input.view, found.runs);
  const runs = found.runs.map((run): FactoryItemRun => {
    const fact = facts.get(run.id);
    const cause = causes.get(run.id) ?? null;
    return {
      runId: run.id,
      workflow: itemRunWorkflow(input.view, input.pack, run.workflow_name),
      ...(cause === null ? {} : { cause }),
      costUsd: parseRunUsage(run.metadata).costUsd ?? null,
      step: run.status === 'running' ? (fact?.active ?? null) : null,
      rounds: fact?.rounds ?? null,
      shadows: fact?.shadows ?? [],
      change: fact?.change?.url ?? null,
      ...(stories.get(run.id) ?? { said: null, models: [], steps: [] }),
    };
  });
  return { pack: input.pack, item, runs };
}

/** A run's workflow as the view names it, its `discoveries` drain too (on no stage: it places nothing). */
function itemRunWorkflow(view: FactoryView, pack: string, recorded: string): string | null {
  const drain = view.discoveries?.workflow;
  if (drain !== undefined && factoryRunWorkflowName(pack, drain) === recorded) return drain;
  return declaredWorkflow(view, pack, recorded);
}

async function itemProgress(
  source: ItemReadSource,
  input: ReadFactoryItemsInput,
  item: FoundItem,
  facts: ReadonlyMap<string, FactoryRunFacts>
): Promise<FactoryItemProgress | null> {
  const declared = item.runs.filter(
    run => declaredWorkflow(input.view, input.pack, run.workflow_name) !== null
  );
  // A declared run whose facts failed leaves the item's progress unknown, not partial.
  if (declared.some(run => !facts.has(run.id))) return null;
  try {
    // An unreadable merge row reads as none: the change host is asked, and the item read's
    // own `degraded` reports the row.
    const merge = await source.store.getItemMerge(item.item.id);
    return await factoryItemProgress(
      input.view,
      input.pack,
      item.runs,
      facts,
      input.changeState,
      run => source.branchOf(run),
      merge === null || 'type' in merge ? null : { change: merge.change, at: merge.at }
    );
  } catch (error) {
    input.onProgressError(item.item.id, error);
    return null;
  }
}
