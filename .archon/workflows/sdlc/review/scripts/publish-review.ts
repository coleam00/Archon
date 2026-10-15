/**
 * Publish the review report as the pull request's one canonical comment.
 *
 * The reviewer judges and writes the report; this node owns the public write, so
 * every round edits the same marked comment instead of appending another. A
 * review whose scope was a working diff has no pull request and publishes
 * nothing. The verdict passes through unchanged either way: publication is not
 * what makes a review true.
 *
 * A report goes public only about the commit its round fixed at the start
 * (review-round): the checkout must still be at it and the pull request's remote
 * head must be it. The head is checked before the scope agent's declaration, so a
 * correction that was never pushed is named as that rather than as a scope
 * mismatch. Any mismatch refuses, so a verdict about one commit can never
 * stand as the verdict on another. This node stamps that commit on the comment
 * itself rather than trusting the report's text to name it. Once published, the
 * commit is recorded beside the report as the next round's cursor.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SCOPE: the review's requested scope. Delivery passes its verified
 *   pull-request record here, and that record is then the only write target.
 * - INPUTS_PR: the qualified pull request the scope agent declared it reviewed,
 *   or `null` for a working diff. An explicit scope remains the write target.
 * - INPUTS_REPORT: path to the report this node publishes.
 * - INPUTS_HEAD: the commit this round reviewed, as review-round fixed it.
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER /
 *   INPUTS_DISCOVERIES / INPUTS_CONTRACT_LEFT: the certified verdict fields this
 *   node forwards.
 * - INPUTS_ROUTE / INPUTS_MODE: the route agent's lens decision ("null" when a
 *   continuation skipped it) and review-round's output, whose lens fields hold a
 *   continuation's set. The lenses this round ran are recorded beside the report
 *   as the next round's lens set.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { upsertComment, viewPr } from '../../.shared/pr.ts';
import { forgeSource, record, sameRepo, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { recordedPr, declaredPr, resolveReviewPr } from '../../.shared/review-target.ts';
import { REVIEW_LENSES } from '../../.shared/review-policy.ts';

const MARKER = '<!-- archon-review-report -->';

/** The lenses this round ran: the route agent's call on a first round, review-round's otherwise. */
function lenses(): Record<string, boolean> {
  const decision = record(JSON.parse(text(process.env.INPUTS_ROUTE) || 'null'));
  const source = decision ?? record(JSON.parse(text(process.env.INPUTS_MODE)));
  return Object.fromEntries(REVIEW_LENSES.map(lens => [lens, source?.[lens] === true]));
}

function label(pr: QualifiedPr | undefined): string {
  return pr ? `${pr.repo.host}/${pr.repo.path}#${String(pr.number)}` : 'no pull request';
}

try {
  const source = forgeSource();
  const verdict = {
    ready: JSON.parse(text(process.env.INPUTS_READY)) as boolean,
    action: text(process.env.INPUTS_ACTION),
    findings_summary: text(process.env.INPUTS_SUMMARY),
    report: JSON.parse(text(process.env.INPUTS_REPORT_POINTER)) as unknown,
    discoveries: JSON.parse(text(process.env.INPUTS_DISCOVERIES)) as unknown,
    contract_left: JSON.parse(text(process.env.INPUTS_CONTRACT_LEFT)) as unknown,
  };
  const recorded = recordedPr(text(process.env.INPUTS_SCOPE));
  const declared = declaredPr(text(process.env.INPUTS_PR));
  const scope = text(process.env.INPUTS_SCOPE).trim();
  const requested = !recorded && scope ? resolveReviewPr(scope, source) : undefined;
  const bound = recorded ?? requested;
  const pr = bound ?? declared;
  const head = text(process.env.INPUTS_HEAD).trim();
  const reportPath = text(process.env.INPUTS_REPORT);
  const report = readFileSync(reportPath, 'utf8');
  if (report.trim() === '') throw new Error('the review report is empty');
  const checkout = nodeStartCommit();
  if (checkout !== head) {
    throw new Error(`this round reviewed ${head}, but the checkout is now at ${checkout}`);
  }
  if (pr) {
    const remote = requested ? requested.head_revision : viewPr(pr, source).pr.head_revision;
    if (remote !== head) {
      throw new Error(
        `this round reviewed ${head}, but ${label(pr)} is at ${remote ?? 'an unknown head'}: the commits under review were not pushed`
      );
    }
  }
  if (bound && (declared?.number !== bound.number || !sameRepo(declared.repo, bound.repo))) {
    throw new Error(
      `the review scope declared ${label(declared)}, but ${recorded ? 'delivery recorded' : 'the requested scope names'} ${label(bound)}`
    );
  }
  if (!pr) {
    note('publish-review: the review scope is a working diff, so no comment was published.');
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'archon-review-'));
    try {
      const marked = join(directory, 'comment.md');
      writeFileSync(marked, `${MARKER}\nReviewed commit: \`${head}\`\n\n${report}`);
      const comment = upsertComment(pr, MARKER, marked, source);
      note(`publish-review: canonical review comment at ${comment.url}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // review-round reads these as the next round's cursor and lens set.
  writeFileSync(join(dirname(reportPath), 'reviewed-head'), `${head}\n`);
  writeFileSync(join(dirname(reportPath), 'reviewed-lenses.json'), JSON.stringify(lenses()));
  emit(verdict);
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}
