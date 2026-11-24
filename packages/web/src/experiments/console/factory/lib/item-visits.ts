/**
 * Where an item went, stage by stage: the item page's story panels and journey strip both read
 * it (DESIGN.md, The item page). A run of a workflow one stage lists works that stage; a run of
 * a workflow several stages list (a loop-form delivery) moves between them as its steps start,
 * each step placed by the stage whose `nodes` name it (`stageOfStep`), so placement stays the
 * board's. A step no stage names (a loop group between rounds) leaves the run where it was.
 */
import type { FactoryItemDetail } from '../../skills/factory';
import { placedStage, stageOfStep, stageOfWorkflow } from './placement';
import type { FactoryStage } from './stage-steps';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];
export type ItemRun = FactoryItemDetail['item']['runs'][number];
export type RunFacts = FactoryItemDetail['runs'][number];

/** The item entered `stage` at `at`, by a step of run `runId` (null: the run's own start). */
export interface Position {
  stage: FactoryStage;
  at: number;
  runId: string;
  node: string | null;
}

/** Consecutive positions on one stage: one stretch of work there. */
export interface Visit {
  stage: FactoryStage;
  /** The runs that worked it, in start order, each once. */
  runIds: string[];
  positions: Position[];
}

/**
 * One panel of the story: a visit to a stage, with the build visits folded into it that fixed
 * what it sent back before it looked again (`fixRunIds`). `number` counts the panels of the
 * same stage so far, so a stage met again reads "Plan (2)".
 */
export interface StoryVisit {
  stage: FactoryStage;
  number: number;
  runIds: string[];
  fixRunIds: string[];
  positions: Position[];
  /** Every run in it, its own and its fixes', in start order. */
  allRunIds: string[];
}

/** A run's workflow as the view names it, when it works a stage (not the discoveries drain). */
export function stageWorkflow(view: Declaration, facts: RunFacts | undefined): string | null {
  const workflow = facts?.workflow ?? null;
  if (workflow === null || workflow === view.discoveries?.workflow) return null;
  return view.stages.some(stage => stage.workflows.includes(workflow)) ? workflow : null;
}

/**
 * Where one run took the item, in time order. A workflow one stage lists is one position at the
 * run's start. One several stages list starts where its first named step is (else where the
 * workflow starts), and moves at each step a stage's `nodes` name.
 */
export function runPositions(
  view: Declaration,
  run: ItemRun,
  facts: RunFacts | undefined
): Position[] {
  const workflow = stageWorkflow(view, facts);
  if (workflow === null) return [];
  const listing = view.stages.filter(stage => stage.workflows.includes(workflow));
  const steps = facts?.steps ?? [];
  const named = steps.flatMap(step => {
    const stage = listing.length === 1 ? undefined : stageOfStep(view, workflow, step.node);
    return stage === undefined ? [] : [{ stage, at: Date.parse(step.startedAt), node: step.node }];
  });
  const first =
    listing.length === 1 ? listing[0] : (named[0]?.stage ?? stageOfWorkflow(view, workflow, null));
  if (first === undefined) return [];
  const positions: Position[] = [
    { stage: first, at: Date.parse(run.startedAt), runId: run.id, node: named[0]?.node ?? null },
  ];
  for (const step of named)
    if (positions.at(-1)?.stage.id !== step.stage.id) positions.push({ ...step, runId: run.id });
  return withoutClosingMove(view, workflow, run, positions);
}

/**
 * A run's closing steps may sit on another stage (a delivery's ending steps are declared on CI
 * and review) without the run having worked there: a build that stopped to ask still runs
 * them. When the completed run's outcome places the item back on the stage it worked before
 * that last move, the move was only its closing, and the story leaves the run where it worked.
 */
function withoutClosingMove(
  view: Declaration,
  workflow: string,
  run: ItemRun,
  positions: Position[]
): Position[] {
  const before = positions.at(-2);
  if (run.status !== 'completed' || before === undefined) return positions;
  const placed = placedStage(view, workflow, run.outcome);
  return placed?.id === before.stage.id ? positions.slice(0, -1) : positions;
}

/** Every position of the item's stage-working runs, in time order. */
export function itemPositions(view: Declaration, detail: FactoryItemDetail): Position[] {
  const facts = new Map(detail.runs.map(entry => [entry.runId, entry]));
  return detail.item.runs
    .flatMap(run => runPositions(view, run, facts.get(run.id)))
    .sort((a, b) => a.at - b.at);
}

/** Consecutive positions on one stage, as visits. */
function stageVisits(view: Declaration, detail: FactoryItemDetail): Visit[] {
  const visits: Visit[] = [];
  for (const position of itemPositions(view, detail)) {
    const last = visits.at(-1);
    if (last?.stage.id === position.stage.id) {
      last.positions.push(position);
      if (!last.runIds.includes(position.runId)) last.runIds.push(position.runId);
    } else visits.push({ stage: position.stage, runIds: [position.runId], positions: [position] });
  }
  return visits;
}

/**
 * A build visit between two visits of one check stage is that stage's fix: the checks sent the
 * change back, the builder fixed it, the same checks looked again. It folds into the check
 * stage's panel, and the visit after it joins that panel too, so build and check ping-pong
 * (a stage-form delivery, or a loop's fix step) reads as one Checks panel.
 */
function isFix(before: Visit | undefined, visit: Visit, after: Visit | undefined): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    visit.stage.group === 'build' &&
    before.stage.group === 'check' &&
    after.stage.id === before.stage.id
  );
}

/** The story's panels in order: visits with their fixes folded in, each numbered by its stage. */
export function storyVisits(view: Declaration, detail: FactoryItemDetail): StoryVisit[] {
  const visits = stageVisits(view, detail);
  const panels: StoryVisit[] = [];
  visits.forEach((visit, index) => {
    const open = panels.at(-1);
    if (isFix(visits[index - 1], visit, visits[index + 1]) && open !== undefined) {
      open.fixRunIds.push(...visit.runIds.filter(id => !open.fixRunIds.includes(id)));
      open.positions.push(...visit.positions);
      return;
    }
    if (open?.stage.id === visit.stage.id) {
      open.runIds.push(...visit.runIds.filter(id => !open.runIds.includes(id)));
      open.positions.push(...visit.positions);
      return;
    }
    const number = panels.filter(panel => panel.stage.id === visit.stage.id).length + 1;
    panels.push({
      ...visit,
      number,
      fixRunIds: [],
      allRunIds: [],
      positions: [...visit.positions],
    });
  });
  const order = new Map(detail.item.runs.map((run, index) => [run.id, index]));
  for (const panel of panels)
    panel.allRunIds = [...new Set([...panel.runIds, ...panel.fixRunIds])].sort(
      (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
    );
  return panels;
}
