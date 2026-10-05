/**
 * Decide this round's lens coverage once the focused reviewer, if any, has reported.
 *
 * A first round on the full tier enables code, tests and simplify; on the focused
 * tier they run only when the focused reviewer escalated to full review. Errors and
 * docs follow their inputs. The rule lives in ../../.shared/review-lenses.ts, which
 * the lens-status node reads too.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_CONTINUATION: whether the round continues a previous one.
 * - INPUTS_TIER: the requested tier.
 * - INPUTS_FOCUSED: the focused reviewer's output, or `null` when it did not run.
 * - INPUTS_ERRORS / INPUTS_DOCS: the errors and docs inputs.
 * - INPUTS_SCOPE_DOCS: whether the scope node selected docs.
 */

import { emit, refuse } from '../../.shared/io.ts';
import { enabledLenses } from '../../.shared/review-lenses.ts';

try {
  const continuation = process.env.INPUTS_CONTINUATION;
  if (continuation !== 'true' && continuation !== 'false') {
    throw new Error('continuation must be a boolean');
  }
  const tier = process.env.INPUTS_TIER;
  if (tier === undefined) throw new Error('tier is missing');
  const focused = JSON.parse(process.env.INPUTS_FOCUSED ?? 'null') as {
    full_review: boolean;
  } | null;
  if (continuation === 'false' && tier === 'focused' && focused === null) {
    throw new Error('an enabled focused review must declare full_review');
  }
  const lenses = enabledLenses({
    continuation: continuation === 'true',
    tier,
    focusedFull: focused?.full_review ?? null,
    errors: process.env.INPUTS_ERRORS ?? '',
    docs: process.env.INPUTS_DOCS ?? '',
    scopeDocs: process.env.INPUTS_SCOPE_DOCS === 'true',
  });
  emit({
    full: lenses.includes('code'),
    errors: lenses.includes('errors'),
    docs: lenses.includes('docs'),
    lenses,
  });
} catch (error) {
  refuse(`resolve-review-coverage: ${error instanceof Error ? error.message : String(error)}`);
}
