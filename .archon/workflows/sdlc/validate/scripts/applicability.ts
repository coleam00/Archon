/**
 * Whether this validation can reuse a verdict already reached in this run.
 *
 * Runs on every pass, resume included (`always_run`), because what it decides is a
 * fact about the checkout now, not about the pass that cached it. `reuse: true`
 * only when the recorded verdict was green with performed checks and the tracked
 * tree, scope, context, validator and report all still match; the rules live in
 * `.shared/validation-evidence.ts`.
 */
import { dirname, join } from 'node:path';
import { emit, text } from '../../.shared/io.ts';
import { checkApplicability } from '../../.shared/validation-evidence.ts';

const packRoot = join(dirname(import.meta.path), '..', '..');
emit(
  await checkApplicability(
    process.cwd(),
    packRoot,
    text(process.env.INPUTS_SCOPE),
    text(process.env.INPUTS_CONTEXT)
  )
);
