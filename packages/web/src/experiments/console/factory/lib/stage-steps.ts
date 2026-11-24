import { factoryPath, type FactoryViewListed } from './views';

export type FactoryStage = FactoryViewListed['declaration']['stages'][number];

/**
 * Whether a step of one of `stage`'s workflows belongs to the stage. A stage without
 * `nodes` holds every step; with them, a step belongs when its key is a listed node or
 * begins with one followed by `.`, so `rounds` holds `rounds.fix`.
 */
export function stepInStage(stage: Pick<FactoryStage, 'nodes'>, stepKey: string): boolean {
  if (stage.nodes === undefined) return true;
  return stage.nodes.some(node => stepKey === node || stepKey.startsWith(`${node}.`));
}

/** A step page's address: `factory/steps/:workflow/:node`. */
export function stepPagePath(projectId: string, workflow: string, stepKey: string): string {
  return factoryPath(
    projectId,
    `/steps/${encodeURIComponent(workflow)}/${encodeURIComponent(stepKey)}`
  );
}

/** What a stage hands the step page, so its back link returns to that stage. */
export interface StepPageState {
  fromStage: string;
}

/** The stage a step page was opened from, when router state says. */
export function stepPageFromStage(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('fromStage' in state)) return undefined;
  return typeof state.fromStage === 'string' ? state.fromStage : undefined;
}

/**
 * The workflows `stage` draws and links: those it lists that the view has not retired. A
 * retired workflow still places and tells its old runs (so every placement reader keeps
 * `stage.workflows`), but the pack has no file for it to draw and no step page to open.
 */
export function liveWorkflows(
  view: Pick<FactoryViewListed['declaration'], 'retired'>,
  stage: Pick<FactoryStage, 'workflows'>
): string[] {
  return stage.workflows.filter(workflow => view.retired?.includes(workflow) !== true);
}

/** The stages that list `workflow`, in the view's order. */
export function stagesOfWorkflow(
  stages: readonly FactoryStage[],
  workflow: string
): FactoryStage[] {
  return stages.filter(stage => stage.workflows.includes(workflow));
}

/** A stage as a step's tag names it: its id to open it, its label, its group's colour. */
type StepStage = Pick<FactoryStage, 'id' | 'label' | 'group'>;

/**
 * Who works a step of the graph a stage draws: the open stage (`this`), another stage that
 * lists the same workflow (`other`, the first in the view's order), or no stage the view names.
 */
export type StepWorker =
  | { kind: 'this'; stage: StepStage }
  | { kind: 'other'; stage: StepStage }
  | { kind: 'none' };

const NONE: StepWorker = { kind: 'none' };

/**
 * Who works step `key` of `workflow` in the graph `stage` draws, from the view file alone. A
 * stage that works its whole workflow (no `nodes`) shares none of it, so no step is marked:
 * every step would be its own, and a ring on each tells nothing.
 */
export function stepWorker(
  stages: readonly FactoryStage[],
  stage: FactoryStage,
  workflow: string,
  key: string
): StepWorker {
  if (stage.nodes === undefined) return NONE;
  if (stepInStage(stage, key)) return { kind: 'this', stage: stepStage(stage) };
  const other = stagesOfWorkflow(stages, workflow).find(
    candidate => candidate.id !== stage.id && stepInStage(candidate, key)
  );
  return other === undefined ? NONE : { kind: 'other', stage: stepStage(other) };
}

const stepStage = ({ id, label, group }: FactoryStage): StepStage => ({ id, label, group });
