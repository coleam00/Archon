/**
 * The terminal report of the delivery tail (archon-deliver) and the build block
 * (archon-build) on every ending, a node failure included.
 *
 * When the workflow's outcome node ran, its report passes through unchanged; in the
 * build block a failed delivery reaches it as deliver's own `failed` or
 * `pr_create_unresolved` report. When a node failure kept it from running, the report is
 * not done, with a failure reason, and names the pull request a round already
 * published; the run still fails, and its terminal record names the node that failed.
 *
 * The outcome is a node of its own because a binding to a failed producer fails its
 * consumer: only a node the failure skips can be read here as null.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_FLAG: the report's done flag, `ready` (deliver) or `delivered` (build).
 * - INPUTS_OUTCOME: the outcome node's report, or "null" when a node failure kept it
 *   from running.
 * - INPUTS_PULL_REQUESTS: every `pull-request` output of this run.
 */

import { artifactsDir, emit, input } from 'archon:script';
import { nullableJson, typedOutputs } from '../inputs.ts';
import { FAILED_SUMMARY, failedPublication } from '../report.ts';

const flag = input('flag');
if (flag !== 'ready' && flag !== 'delivered') throw new Error(`report: flag must be ready or delivered, not "${flag}"`);

const outcome = nullableJson(input('outcome'));
emit(
  outcome ?? {
    [flag]: false,
    ...failedPublication(artifactsDir(), { pullRequests: typedOutputs(input('pull_requests')) }),
    summary: FAILED_SUMMARY,
  }
);
