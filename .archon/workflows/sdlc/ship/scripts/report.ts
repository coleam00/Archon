/**
 * The ship tail's terminal report on every ending, a node failure included.
 *
 * When the outcome node ran, its report passes through unchanged; a failed delivery
 * reaches it as deliver's own `failed` or `pr_create_unresolved` report. When a node
 * failure before delivery, such as a planner or investigator crash, kept it from
 * running, the report is not delivered with a failure reason; the run still fails,
 * and its terminal record names the node that failed.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_OUTCOME: the outcome node's report, or "null" when a node failure kept it
 *   from running.
 */

import { artifactsDir, emit, nullableJson } from '../../.shared/io.ts';
import { failed, failedPublication } from '../../.shared/report.ts';

const outcome = nullableJson(process.env.INPUTS_OUTCOME);
emit(
  outcome ?? {
    delivered: false,
    ...failedPublication(artifactsDir(), { listingFile: process.env.TYPED_ARTIFACTS_FILE }),
    summary: failed(artifactsDir(), { listingFile: process.env.TYPED_ARTIFACTS_FILE }),
  }
);
