/**
 * A stage's words as a person reads them: the one place the map, its stage modal and the board
 * take a stage's display name from. Its `display.label` in the pack graph (`graph-view.ts`) when
 * it gives one, else the stage's id cleaned up. The raw workflow id is a key and a hover title, never the name on screen
 * (DESIGN.md, Visual standard: plain words first, ids second).
 */
import type { FactoryWords } from './graph-view';

/** A stage's id as words: `build-and-test` reads "Build and test". */
export function stageWords(workflow: string): string {
  const spaced = workflow.replace(/[_-]+/g, ' ').trim();
  return spaced === '' ? workflow : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A stage's name: its label in the graph's words, else its id as words. */
export function stageLabel(
  view: Pick<FactoryWords, 'stages'> | null | undefined,
  workflow: string
): string {
  return view?.stages[workflow]?.label ?? stageWords(workflow);
}
