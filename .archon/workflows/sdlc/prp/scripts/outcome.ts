/**
 * The run's typed result. `ready: true` is reported only when the latest independent
 * review is ready, the pull request the owner named is open on this checkout's branch
 * and commit, and a fresh read of its checks is green (or the repository has no CI).
 * Every other ending names why. The owner's account of CI is context for the reason,
 * never evidence of green: the checks are read here, once, at the end.
 *
 * Bound inputs (canonical text; a skipped producer arrives as "null"):
 * - INPUTS_PLAN_READY / INPUTS_PLAN_SUMMARY: the plan's verdict.
 * - INPUTS_GREEN / INPUTS_PR / INPUTS_IMPLEMENT_SUMMARY: the implementation's.
 * - INPUTS_REVIEW_READY / INPUTS_REVERIFY_READY: the first review and the verify review.
 * - INPUTS_CI_CAUSE / INPUTS_FINISH_SUMMARY: the owner's correction pass.
 */

import {
  approvalPending,
  atRevision,
  describeUnits,
  gateState,
  hasActiveWorkflows,
  readPrChecks,
} from '../../.shared/checks.ts';
import { forgeSource, parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { viewPr } from '../../.shared/pr.ts';
import { artifactsDir, emit, refuse, text } from '../../.shared/io.ts';

type Reason =
  | 'delivered'
  | 'plan_blocked'
  | 'implement_blocked'
  | 'review_open'
  | 'ci_red'
  | 'ci_red_not_caused'
  | 'ci_pending'
  | 'ci_gated'
  | 'ci_missing'
  | 'pr_mismatch';

const planReady = text(process.env.INPUTS_PLAN_READY);
const planSummary = text(process.env.INPUTS_PLAN_SUMMARY);
const green = text(process.env.INPUTS_GREEN);
const boundPr = process.env.INPUTS_PR;
const implementSummary = text(process.env.INPUTS_IMPLEMENT_SUMMARY);
const reviewReady = text(process.env.INPUTS_REVIEW_READY);
const reverifyReady = text(process.env.INPUTS_REVERIFY_READY);
const ciCause = text(process.env.INPUTS_CI_CAUSE);
const finishSummary = text(process.env.INPUTS_FINISH_SUMMARY);

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.toString().trim();
}

function result(reason: Reason, prUrl: string, summary: string): void {
  emit({
    ready: reason === 'delivered',
    reason,
    pr_url: prUrl,
    summary: `${summary}\nReports: ${artifactsDir()}`,
  });
}

/** Why the PR the owner named is not this run's delivery, or undefined when it is. */
function mismatch(pr: QualifiedPr): string | undefined {
  const view = viewPr(pr, forgeSource()).pr;
  const branch = git('branch', '--show-current');
  const head = git('rev-parse', 'HEAD');
  if (view.state !== 'open') return `the PR is ${view.state}`;
  if (view.head !== branch) return `the PR's head is ${view.head}, not this run's ${branch}`;
  if (view.head_revision !== null && view.head_revision !== head) {
    return `the PR's head is at ${view.head_revision}, but this checkout is at ${head} (unpushed or diverged)`;
  }
  return undefined;
}

function decide(): void {
  if (planReady !== 'true') {
    result('plan_blocked', '', `Planning stopped before any code: ${planSummary}`);
    return;
  }
  if (green !== 'true') {
    result('implement_blocked', '', `Implementation did not reach green: ${implementSummary}`);
    return;
  }
  const pr = parseQualifiedPr(boundPr);
  const url = (JSON.parse(boundPr ?? '{}') as { url?: string }).url ?? '';
  // The verify review supersedes the first one whenever it ran; it runs whenever the
  // first was not ready, so a skipped verify means the first review stands.
  const latest = reverifyReady === 'null' ? reviewReady : reverifyReady;
  if (latest !== 'true') {
    result('review_open', url, `The independent review is not ready. ${finishSummary}`);
    return;
  }
  const wrong = mismatch(pr);
  if (wrong !== undefined) {
    result('pr_mismatch', url, `The named PR is not this delivery: ${wrong}.`);
    return;
  }
  const read = readPrChecks(pr);
  const at = atRevision(read);
  const checks = `${describeUnits(read.units) || 'no checks'}${at}`;
  switch (gateState(read.units, approvalPending(read))) {
    case 'green':
      result('delivered', url, `Review ready; checks green: ${checks}.`);
      return;
    case 'none':
      if (read.source === 'gh' && hasActiveWorkflows(pr) === false) {
        result('delivered', url, 'Review ready; the repository has no CI configured.');
      } else {
        result('ci_missing', url, `CI is configured but no checks ran${at}.`);
      }
      return;
    case 'pending':
      result('ci_pending', url, `Checks are still running: ${checks}.`);
      return;
    case 'gated':
      result('ci_gated', url, `CI is waiting on a maintainer's approval: ${checks}.`);
      return;
    case 'red':
      if (ciCause === 'inherited' || ciCause === 'environment') {
        result(
          'ci_red_not_caused',
          url,
          `Checks are red and the owner judged the cause ${ciCause}: ${checks}. ${finishSummary}`
        );
      } else {
        result('ci_red', url, `Checks are red: ${checks}. ${finishSummary}`);
      }
      return;
  }
}

try {
  decide();
} catch (error) {
  refuse(`outcome: ${error instanceof Error ? error.message : String(error)}`);
}
