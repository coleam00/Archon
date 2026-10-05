/**
 * Which review lenses a round enables: the one place the rule is written.
 *
 * The coverage node emits the flags the code, tests, simplify, errors and docs lenses
 * gate on, and the lens-status node computes which enabled lenses did not complete,
 * both from this function. Seams and focused gate before coverage exists, so their
 * `when:` expressions in archon-review.yaml restate the first two lines below; a
 * conformance test holds the two in step.
 */

export const LENSES = ['seams', 'focused', 'code', 'tests', 'simplify', 'errors', 'docs'] as const;
export type Lens = (typeof LENSES)[number];

export interface LensInputs {
  /** The round continues a previous one: one continuation reviewer, no lenses. */
  readonly continuation: boolean;
  /** The requested tier: `focused`, or anything else for full. */
  readonly tier: string;
  /** The focused reviewer escalated to full coverage; null when it did not report. */
  readonly focusedFull: boolean | null;
  /** The errors input: `true` enables the errors lens. */
  readonly errors: string;
  /** The docs input: `true`, `false`, or `auto` to follow the scope's selection. */
  readonly docs: string;
  /** The scope node selected docs (consulted for `auto`). */
  readonly scopeDocs: boolean;
}

export function enabledLenses(input: LensInputs): Lens[] {
  if (input.continuation) return [];
  const focused = input.tier === 'focused';
  const full = !focused || input.focusedFull === true;
  const lenses: Lens[] = ['seams'];
  if (focused) lenses.push('focused');
  if (full) lenses.push('code', 'tests', 'simplify');
  if (input.errors === 'true') lenses.push('errors');
  if (input.docs === 'true' || (input.docs === 'auto' && input.scopeDocs)) lenses.push('docs');
  return lenses;
}
