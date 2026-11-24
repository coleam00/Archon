/**
 * A step's name as a person reads it (DESIGN.md, "Step names, everywhere a person reads").
 * Every page that shows a step prints it through `stepLabel`; the raw engine id stays in
 * routes, keys and `title` attributes, and on the step page as the id tag beside its name.
 */
import { stageOfStep, stageOfWorkflow, type PlacementRun } from './placement';
import { stepInStage, type FactoryStage } from './stage-steps';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];

type RoundsSource = Exclude<NonNullable<Declaration['rounds']>, readonly unknown[]>;

/** The view's rounds sources as a list: the file gives one, or a list of them. */
export function roundsSources(view: Declaration): RoundsSource[] {
  return view.rounds === undefined ? [] : [view.rounds].flat();
}

/**
 * Whether `stepId` of `workflow` is a declared rounds loop or one of its bodies: only those
 * steps take that loop's round, so a step of another loop never reads its iteration. A
 * stage-form source has no loop: its run's round is known only from its result.
 */
function inRoundsLoop(view: Declaration, workflow: string, stepId: string): boolean {
  return roundsSources(view).some(
    source =>
      'loop' in source &&
      source.workflow === workflow &&
      stepInStage({ nodes: [source.loop] }, stepId)
  );
}

/**
 * An undeclared id made readable: loop group prefixes (`rounds.`) are dropped, a doubled
 * include name collapses (`build__build` reads "build"), an include reads "include: inner",
 * and `_` and `-` become spaces. An id that cleans to nothing reads as itself.
 */
function cleanedId(stepId: string): string {
  const step = stepId.split('.').at(-1) ?? '';
  const parts = step
    .split('__')
    .filter((part, index, all) => part !== '' && part !== all[index - 1])
    .map(part => part.replace(/[_-]+/g, ' ').trim())
    .filter(part => part !== '');
  return parts.length === 0 ? stepId : parts.join(': ');
}

/**
 * The display name of a step: the name the view's `steps` gives it, else its cleaned id.
 * With `iteration`, a step of the declared rounds loop adds ", round N"; any other step
 * ignores it.
 */
export function stepLabel(
  view: Declaration,
  workflow: string,
  stepId: string,
  iteration?: number
): string {
  const name = view.steps?.[workflow]?.[stepId] ?? cleanedId(stepId);
  return iteration !== undefined && inRoundsLoop(view, workflow, stepId)
    ? `${name}, round ${iteration.toString()}`
    : name;
}

/**
 * The round a running step of run `runId` is on: the items read's latest round when it is
 * this run's and the step is of the declared rounds loop, else undefined.
 */
export function roundOfStep(
  view: Declaration,
  workflow: string,
  stepId: string,
  round: { runId: string; iteration: number } | null | undefined,
  runId: string
): number | undefined {
  if (round?.runId !== runId || !inRoundsLoop(view, workflow, stepId)) return undefined;
  return round.iteration;
}

/** The engine id beside a step's name, for a hover title only. */
export function engineIdTitle(text: string, step: string | null): string {
  return step === null ? text : `${text} (engine id: ${step})`;
}

/** What a running run is doing, in a person's words: its stage, step and round. */
export interface RunLine {
  /**
   * The line's parts, in order: the declared stage the step counts in (else the workflow),
   * the step's name or "between steps", and "round N" when the round is known.
   */
  parts: string[];
  /** The parts joined: "<stage> · <step name> · round N", or "<stage> · between steps". */
  text: string;
}

/**
 * The one line every live surface prints for a running run (the board card, Table, map).
 * The stage is the one whose `nodes` name the step; on a step no stage names, the stage the
 * item is `placed` in when it lists the workflow, as placement holds it there; else the
 * workflow's own stage. So a card never names a stage other than its column for its run.
 */
export function runLine(
  view: Declaration,
  running: { runId: string; workflow: string; step: string | null },
  round: { runId: string; iteration: number } | null | undefined,
  placed?: FactoryStage
): RunLine {
  const { workflow, step } = running;
  const holds = placed?.workflows.includes(workflow) === true ? placed : undefined;
  const stage =
    (step === null ? undefined : stageOfStep(view, workflow, step))?.label ??
    holds?.label ??
    stageOfWorkflow(view, workflow, step)?.label ??
    workflow;
  const name = step === null ? null : stepLabel(view, workflow, step);
  const of =
    step === null ? null : (roundOfStep(view, workflow, step, round, running.runId) ?? null);
  const parts = [
    stage,
    name ?? 'between steps',
    ...(of === null ? [] : [`round ${of.toString()}`]),
  ];
  return { parts, text: parts.join(' · ') };
}

/**
 * What stopped a run, its stage named by `label`, never its workflow (a run's workflow is the
 * pack's full id, which a person does not read): "Build failed at Writes the change", "Build
 * failed", or "Build was stopped". The board's stop line and the item's story both say it.
 */
export function stoppedLine(
  view: Declaration,
  run: Pick<PlacementRun, 'workflow' | 'status' | 'failedStep'>,
  label: string
): string {
  if (run.status === 'cancelled') return `${label} was stopped`;
  return run.workflow === null || run.failedStep === null
    ? `${label} failed`
    : `${label} failed at ${stepLabel(view, run.workflow, run.failedStep)}`;
}
