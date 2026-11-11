/**
 * Publish the review report as the pull request's one canonical comment.
 *
 * The reviewer judges and writes the report; this node owns the public write, so
 * every round edits the same marked comment instead of appending another. A review
 * whose scope was a working diff has no pull request and publishes nothing. The
 * verdict passes through unchanged either way: publication is not what makes a
 * review true.
 *
 * This is the review's one head check. A report goes public only about the
 * commit its round fixed at the start (review-round): the checkout must still be
 * at it and the pull request's remote head must be it. Any mismatch refuses, so a verdict about one commit can never
 * stand as the verdict on another. This node stamps that commit and the certified
 * verdict on the comment itself (../../.shared/review-comment.ts) rather than trusting
 * the report's text to name them; the merge queue's gate reads both. Once published, the
 * commit is recorded beside the report as the next round's cursor.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SCOPE: the review's requested scope. Delivery passes its verified
 *   pull-request record here, and that record is then the only write target.
 * - INPUTS_PR: the qualified pull request the scope agent declared it reviewed,
 *   or `null` for a working diff. It names the target of a standalone review;
 *   under delivery the recorded pull request is the target whatever this says.
 * - INPUTS_REPORT: path to the report this node publishes.
 * - INPUTS_HEAD: the commit this round reviewed, as review-round fixed it.
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER /
 *   INPUTS_DISCOVERIES / INPUTS_CONTRACT_LEFT: the certified verdict fields this
 *   node forwards.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { upsertComment, viewPr } from '../../.shared/pr.ts';
import { emit, input, refuse } from 'archon:script';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/identity.ts';
import { record } from '../../.shared/inputs.ts';
import { REVIEW_MARKER, reviewCommentBody } from '../../.shared/review-comment.ts';

/** The pull request delivery recorded, when the scope is that JSON record. */
function recordedPr(scope: string): QualifiedPr | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    return undefined; // a PR URL, a branch name, or empty
  }
  return record(parsed) ? parseQualifiedPr(scope) : undefined;
}

/** The pull request the scope agent declared, or undefined for a working diff. */
function declaredPr(value: string): QualifiedPr | undefined {
  const target = value.trim() || 'null';
  return JSON.parse(target) === null ? undefined : parseQualifiedPr(target);
}

function label(pr: QualifiedPr | undefined): string {
  return pr ? `${pr.repo.host}/${pr.repo.path}#${String(pr.number)}` : 'no pull request';
}

try {
  const verdict = {
    ready: JSON.parse(input('ready')) as boolean,
    action: input('action'),
    findings_summary: input('summary'),
    report: JSON.parse(input('report_pointer')) as unknown,
    discoveries: JSON.parse(input('discoveries')) as unknown,
    contract_left: JSON.parse(input('contract_left')) as unknown,
  };
  // Complete only on an empty list: a review that left anything open never lets a merge close the issue.
  const coverage = Array.isArray(verdict.contract_left) && verdict.contract_left.length === 0 ? 'complete' : 'open';
  const pr = recordedPr(input('scope')) ?? declaredPr(input('pr'));
  const head = input('head').trim();
  const reportPath = input('report');
  const report = readFileSync(reportPath, 'utf8');
  if (report.trim() === '') throw new Error('the review report is empty');
  const checkout = nodeStartCommit();
  if (checkout !== head) {
    throw new Error(`this round reviewed ${head}, but the checkout is now at ${checkout}`);
  }
  if (pr) {
    const remote = viewPr(pr).pr.head_revision;
    if (remote !== head) {
      throw new Error(
        `this round reviewed ${head}, but ${label(pr)} is at ${remote ?? 'an unknown head'}: push the commits under review, or review from a checkout of the pull request's head`
      );
    }
  }
  if (!pr) {
    console.error('publish-review: the review scope is a working diff, so no comment was published.');
  } else {
    const comment = upsertComment(
      { kind: 'pr', ref: pr },
      REVIEW_MARKER,
      reviewCommentBody(head, verdict.ready, coverage, report)
    );
    console.error(`publish-review: canonical review comment at ${comment.url}`);
  }
  // review-round reads this as the next round's cursor.
  writeFileSync(join(dirname(reportPath), 'reviewed-head'), `${head}\n`);
  emit(verdict);
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}
