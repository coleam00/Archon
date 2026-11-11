/**
 * The report this round's review continues from: the previous round's of this run, else
 * the one the caller passed, an earlier run's published review of the pull request this
 * delivery continues. Neither makes the round a first review of the whole change.
 *
 * Bound inputs (canonical text in env):
 * - INPUTS_PREVIOUS: the previous round's `prior_report` ('' on the first round).
 * - INPUTS_EARLIER: the delivery's `prior_report` input.
 */

import { emit, trimmed } from '../../.shared/io.ts';

emit({ report: trimmed(process.env.INPUTS_PREVIOUS) || trimmed(process.env.INPUTS_EARLIER) });
