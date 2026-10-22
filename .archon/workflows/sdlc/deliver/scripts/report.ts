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
 */

import { artifactsDir, emit, nullableJson } from '../../.shared/io.ts';
import { failed, failedPublication } from '../../.shared/report.ts';

const options = { listingFile: process.env.TYPED_ARTIFACTS_FILE };

const outcome = nullableJson(process.env.INPUTS_OUTCOME);
emit(
  outcome ?? {
    ready: false,
    ...failedPublication(artifactsDir(), options),
    summary: failed(artifactsDir(), options),
  }
);
