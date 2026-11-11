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

import { artifactsDir, emit, input } from 'archon:script';
import { nullableJson, typedOutputs } from '../../.shared/inputs.ts';
import { FAILED_SUMMARY, failedPublication } from '../../.shared/report.ts';

const options = {
  pullRequests: typedOutputs(input('pull_requests')),
};

const outcome = nullableJson(input('outcome'));
emit(
  outcome ?? {
    ready: false,
    ...failedPublication(artifactsDir(), options),
    summary: FAILED_SUMMARY,
  }
);
