/**
 * Where an item sits: the one placement the board, the map and the item page share (owner
 * ruling 2 on #5), and which declared stage a step of a workflow counts in. An item's state
 * pill is the board's (`itemPill` in `board.ts`).
 */
import type { FactoryItem } from '../../skills/factory';
import type { ChangeMerged } from './merge-pending';
import { stagesOfWorkflow, stepInStage, type FactoryStage } from './stage-steps';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
type RunStatus = FactoryItem['runs'][number]['status'];

/**
 * One of an item's runs as placement reads it, in start order. `workflow` is the workflow as
 * the view names it, null for a run of a workflow the view does not name (its `discoveries`
 * drain is skipped too); `step` is the
 * deepest running step while it runs; `failedStep` the step a failed run failed at.
 */
export interface PlacementRun {
  workflow: string | null;
  status: RunStatus;
  outcome: string | null;
  step: string | null;
  failedStep: string | null;
}

export interface PlacementInput {
  runs: readonly PlacementRun[];
  /**
   * Whether the item's change merged; null when it has none. `true` places it in the landed
   * column; a `pending` or `unknown` item sits where its runs put it, unless it sat in the
   * landed column on the caller's last read (`merge-pending.ts`).
   */
  merged: ChangeMerged | null;
}

/** What placement reads of each run beyond the item read's own: its declared workflow and running step. */
export type RunFacts = ReadonlyMap<string, { workflow: string | null; step: string | null }>;

/**
 * Placement's input for an item: its runs in the item read's order joined with `facts` by
 * id (a run without facts is of no declared workflow), and its change's merge state. Every
 * view that places an item builds its input here, so they place it alike. The failed step
 * comes from the item's own `progress.runs`, which the board, map and item page all hold.
 */
export function placementInput(item: FactoryItem, facts: RunFacts): PlacementInput {
  const failedAt = new Map((item.progress?.runs ?? []).map(run => [run.runId, run.failedStep]));
  return {
    runs: item.runs.map(run => {
      const fact = facts.get(run.id);
      return {
        workflow: fact?.workflow ?? null,
        status: run.status,
        outcome: run.outcome,
        step: fact?.step ?? null,
        failedStep: failedAt.get(run.id) ?? null,
      };
    }),
    merged: item.progress?.change?.merged ?? null,
  };
}

/** The run facts one entry of the items read carries: `progress.runs`, with the running run's step. */
export function pageRunFacts(progress: NonNullable<FactoryItem['progress']>): RunFacts {
  const { running } = progress;
  return new Map(
    progress.runs.map(run => [
      run.runId,
      { workflow: run.workflow, step: run.runId === running?.runId ? running.step : null },
    ])
  );
}

/** Where an item sits: a stage's column, or ended without a change (DESIGN board rule 4). */
export type ItemColumn = { stage: FactoryStage } | { ended: string };

/**
 * What the board, the Table and a work order's member say for an item placement found no
 * column for (`null`); the item page says the same.
 */
export const UNPLACED_LABEL = 'Position unknown';

/**
 * The stage of `workflow` that names `step` among its declared `nodes`; undefined when none
 * does. A stage without `nodes` holds every step of its workflow (`stepInStage`), so it is
 * not counted as naming one here: it is the fallback `stageOfWorkflow` picks.
 */
export function stageOfStep(
  view: Declaration,
  workflow: string,
  step: string
): FactoryStage | undefined {
  return stagesOfWorkflow(view.stages, workflow).find(
    stage => stage.nodes !== undefined && stepInStage(stage, step)
  );
}

/**
 * The stage a step or running run of `workflow` counts in: the stage whose `nodes` name the
 * step; else the first of the workflow's stages that declares no `nodes` (it holds every
 * step); else its first stage. A run between steps (`step` null) sits where the workflow starts.
 */
export function stageOfWorkflow(
  view: Declaration,
  workflow: string,
  step: string | null
): FactoryStage | undefined {
  const byStep = step === null ? undefined : stageOfStep(view, workflow, step);
  if (byStep !== undefined) return byStep;
  const stages = stagesOfWorkflow(view.stages, workflow);
  return stages.find(stage => stage.nodes === undefined) ?? stages[0];
}

/**
 * The stage `placement` sends an item to after a run of `workflow` completed with `outcome`:
 * its exact `workflow:outcome` key, else `workflow:*`, which also places a run that returns
 * no outcome (a gate that only records). The board and the item page both read it.
 */
export function placedStage(
  view: Declaration,
  workflow: string,
  outcome: string | null
): FactoryStage | undefined {
  const exact = outcome === null ? undefined : view.placement[`${workflow}:${outcome}`];
  const id = exact ?? view.placement[`${workflow}:*`];
  return id === undefined ? undefined : view.stages.find(stage => stage.id === id);
}

/** Whether a run stopped without completing (failed or cancelled), which rule 5 places by. */
export const isStopped = (status: RunStatus): boolean =>
  status === 'failed' || status === 'cancelled';

/**
 * The stage rule 5 names for a stopped run of `workflow`: the stage whose `nodes` name the step
 * it failed at, else the workflow's first stage. The board's stop line and the item's story
 * name the same one.
 */
export function stoppedStage(
  view: Declaration,
  workflow: string,
  failedStep: string | null
): FactoryStage | undefined {
  const atStep = failedStep === null ? undefined : stageOfStep(view, workflow, failedStep);
  return atStep ?? stagesOfWorkflow(view.stages, workflow)[0];
}

type DeclaredRun = PlacementRun & { workflow: string };

/**
 * The runs placement reads: every run of a workflow the view names but its `discoveries`
 * drain, which places no item (the item page names it). Running beside the land gate, it must
 * not take the item off its column. A workflow no stage lists any more stays, so an item cached
 * under an older view reads as having no column rather than landing in the first stage.
 */
function declaredRuns(view: Declaration, runs: readonly PlacementRun[]): DeclaredRun[] {
  const drain = view.discoveries?.workflow;
  return runs.filter((run): run is DeclaredRun => run.workflow !== null && run.workflow !== drain);
}

/** The ending label for a completed run, from `endings` (`workflow:outcome` or `workflow:*`). */
function endingOf(view: Declaration, run: DeclaredRun): string | undefined {
  if (run.status !== 'completed' || run.outcome === null) return undefined;
  return view.endings[`${run.workflow}:${run.outcome}`] ?? view.endings[`${run.workflow}:*`];
}

/** The landed column's stage. */
function landedStage(view: Declaration): FactoryStage | undefined {
  return view.stages.find(stage => stage.id === view.landed.stage);
}

/**
 * Whether the item sits in the landed column: its change merged, or it sat there on the
 * caller's last read and its merge state is not known now (a lookup still running, or one
 * that failed). A merge does not come undone, so a card never moves back out of Merged
 * because an answer is missing.
 */
function staysLanded(
  view: Declaration,
  merged: PlacementInput['merged'],
  previous?: string
): boolean {
  if (merged === true) return true;
  return previous === view.landed.stage && (merged === 'pending' || merged === 'unknown');
}

/**
 * The stage a running run puts its item in: the stage holding its step (`nodes` name it, or
 * a stage of the workflow declares no `nodes`). On a step no stage names (a loop group
 * between rounds, or none between steps) the item stays in `previous`, the stage it sat in
 * on the last read, when that stage lists the workflow, so a card does not hop; else it goes
 * where the workflow starts.
 */
function runningStage(
  view: Declaration,
  run: DeclaredRun,
  previous: string | undefined
): FactoryStage | undefined {
  const stages = stagesOfWorkflow(view.stages, run.workflow);
  const named = run.step === null ? undefined : stageOfStep(view, run.workflow, run.step);
  return (
    named ??
    stages.find(stage => stage.nodes === undefined) ??
    stages.find(stage => stage.id === previous) ??
    stages[0]
  );
}

/**
 * Where an item sits: DESIGN's placement rules, first that matches. The board, the map and
 * the item page all place through here. `previous` is the stage the item sat in on the
 * caller's last read, if it keeps one (the board does).
 */
export function itemColumn(
  view: Declaration,
  input: PlacementInput,
  previous?: string
): ItemColumn | null {
  const runs = declaredRuns(view, input.runs);
  const stageOf = (stage: FactoryStage | undefined): ItemColumn | null =>
    stage === undefined ? null : { stage };
  // 1. A run works it: the stage its running step is in.
  const running = runs.filter(run => run.status === 'running').at(-1);
  if (running !== undefined) return stageOf(runningStage(view, running, previous));
  // 2. Its change merged (or sat merged on the last read, its state not known now).
  if (staysLanded(view, input.merged, previous)) return stageOf(landedStage(view));
  // 3. The last completed run's `workflow:outcome` is placed, else its `workflow:*`.
  const completed = runs.filter(run => run.status === 'completed').at(-1);
  const placed =
    completed === undefined ? undefined : placedStage(view, completed.workflow, completed.outcome);
  if (placed !== undefined) return stageOf(placed);
  // Rules 4 and 5 read the item's last declared run whatever its status: a run paused or
  // pending after an ending means the item was taken up again, so it is not ended.
  const last = runs.at(-1);
  // 4. The last run ended the item without a change.
  const ending = last === undefined ? undefined : endingOf(view, last);
  if (ending !== undefined) return { ended: ending };
  // 5. The last run failed or was cancelled.
  if (last !== undefined && isStopped(last.status))
    return stageOf(stoppedStage(view, last.workflow, last.failedStep));
  // 6. Otherwise the first stage.
  return stageOf(view.stages[0]);
}

/**
 * Where an entry of the items read sits: the board and the map both place through here, so
 * a column and a card never name different stages. `previous` is the stage the item sat in
 * on the caller's last read. An item whose progress could not be read has no declared runs
 * here, so it sits in the first stage (rule 6).
 */
export function pageItemColumn(
  view: Declaration,
  item: FactoryItem,
  previous?: string
): ItemColumn | null {
  return itemColumn(view, pagePlacementInput(item), previous);
}

/** Placement's input for an entry of the items read, its facts from its own `progress`. */
export function pagePlacementInput(item: FactoryItem): PlacementInput {
  return placementInput(item, item.progress === null ? new Map() : pageRunFacts(item.progress));
}

/** The stage a placement put an item in; undefined when it is off the board or unplaced. */
export function stageIdOf(column: ItemColumn | null): string | undefined {
  return column !== null && 'stage' in column ? column.stage.id : undefined;
}
