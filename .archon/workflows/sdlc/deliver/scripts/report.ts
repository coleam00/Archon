/**
 * The delivery tail's terminal report on every ending, a node failure included.
 *
 * When the outcome node ran, its report passes through unchanged. When a node failure
 * kept it from running, the report is not ready with a failure reason, and names the
 * pull request a round already published; the run still fails, and its terminal
 * record names the node that failed.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_OUTCOME: the outcome node's report, or "null" when a node failure kept it
 *   from running.
 * - INPUTS_PULL_REQUESTS: every `pull-request` output of this run.
 */

import { artifactsDir, emit, nullableJson, typedOutputs } from '../../.shared/io.ts';
import { FAILED_SUMMARY, failedPublication } from '../../.shared/report.ts';

const options = {
  pullRequests: typedOutputs(process.env.INPUTS_PULL_REQUESTS),
  outcomesFile: process.env.NODE_OUTCOMES_FILE,
};

const outcome = nullableJson(process.env.INPUTS_OUTCOME);
emit(
  outcome ?? {
    ready: false,
    ...failedPublication(artifactsDir(), options),
    summary: FAILED_SUMMARY,
  }
);
