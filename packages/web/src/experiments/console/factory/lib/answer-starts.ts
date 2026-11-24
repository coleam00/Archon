import { shortWorkflow } from '../../lib/ask-card';
import type { FactoryViewListed } from './views';

type Declaration = FactoryViewListed['declaration'];

/**
 * What choosing `optionId` on an ask a run of `workflow` left starts, in the view's own
 * sentence (`answers`, keyed `workflow:option`); undefined when the view words none, or
 * without a view or a workflow. The words come from the view: the console names no route.
 */
export function answerStarts(
  declaration: Declaration | null | undefined,
  workflow: string | undefined,
  optionId: string
): string | undefined {
  if (workflow === undefined) return undefined;
  return declaration?.answers?.[`${shortWorkflow(workflow)}:${optionId}`]?.starts;
}
