/**
 * A step's name as a person reads it (DESIGN.md, "Step names, everywhere a person reads").
 * Every place that shows a step prints it through `stepLabel`; the raw engine id stays in
 * keys and `title` attributes.
 */
import type { CuratedView } from './curated-view';

/**
 * An unnamed id made readable: loop group prefixes (`rounds.`) are dropped, a doubled include
 * name collapses (`build__build` reads "build"), an include reads "include: inner", and `_`
 * and `-` become spaces. An id that cleans to nothing reads as itself.
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

/** The display name of a step: the name the view's `steps` gives it, else its cleaned id. */
export function stepLabel(
  view: Pick<CuratedView, 'steps'>,
  workflow: string,
  stepId: string
): string {
  return view.steps[workflow]?.[stepId] ?? cleanedId(stepId);
}

/** The engine id beside a step's name, for a hover title only. */
export function engineIdTitle(text: string, step: string | null): string {
  return step === null ? text : `${text} (engine id: ${step})`;
}
