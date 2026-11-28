import type { CuratedView } from './curated-view';

/** One stage of the map: a map card, standing for one or more graph stages. */
export type FactoryStage = CuratedView['stages'][number];

/** The stages that list `workflow`, in the map's order. */
export function stagesOfWorkflow(
  stages: readonly FactoryStage[],
  workflow: string
): FactoryStage[] {
  return stages.filter(stage => stage.workflows.includes(workflow));
}
