/**
 * Resolve the operator's review-lens override against the classifier's judgment.
 *
 * A declared `true`/`false` beats the classifier; `auto` — or anything else the
 * operator did not declare — adopts its judgment. The values below are the strings
 * the lens gate compares against, not booleans: they travel on as a composed
 * workflow's `errors` input, which is declared text.
 *
 * The docs lens is deliberately absent. It reads the classifier's verdict directly,
 * because it has no operator override to merge over.
 */

import { emit, refuse, text } from '../../.shared/io.ts';

type Verdict = 'true' | 'false';

function isVerdict(value: string): value is Verdict {
  return value === 'true' || value === 'false';
}

const forced = text(process.env.INPUTS_ERRORS);
const judged = text(process.env.INPUTS_C_ERRORS);

if (isVerdict(forced)) {
  emit({ errors: forced });
} else if (!isVerdict(judged)) {
  refuse(`resolve-review-scope: classifier returned an invalid errors verdict: '${judged}'`);
} else {
  emit({ errors: judged });
}
