/**
 * The delivery tail's returned result: the last round's typed ending, plus the
 * discoveries the review accepted, relayed so the operator sees them.
 *
 * Bound input: INPUTS_ROUNDS, the rounds loop's final `round` output.
 */

import { artifactsDir, emit, text } from '../../.shared/io.ts';
import { discoveryReport } from '../../.shared/report.ts';

const rounds = JSON.parse(text(process.env.INPUTS_ROUNDS)) as {
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
};

emit({
  ready: rounds.ready,
  reason: rounds.reason,
  pr_url: rounds.pr_url,
  summary:
    rounds.summary + discoveryReport(artifactsDir()),
});
