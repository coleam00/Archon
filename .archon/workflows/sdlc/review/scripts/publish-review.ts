/**
 * Publish the review report as the pull request's one canonical comment.
 *
 * The reviewer judges and writes the report; this node owns the public write, so
 * every round edits the same marked comment instead of appending another. A
 * review whose scope was a working diff has no pull request and publishes
 * nothing. The verdict passes through unchanged either way: publication is not
 * what makes a review true.
 *
 * Publication rechecks the scoped PR identity, head and effective merge-base.
 * A base may advance without changing the diff; only a changed diff refuses.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_TARGET: the scoped target certified by head-check; the only write target.
 * - INPUTS_REPORT: path to the report this node publishes.
 * - INPUTS_HEAD: the commit this round reviewed, as review-round fixed it.
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER /
 *   INPUTS_DISCOVERIES / INPUTS_CONTRACT_LEFT: the certified verdict fields this
 *   node forwards.
 * - INPUTS_ROUTE / INPUTS_MODE: the route agent's lens decision ("null" when a
 *   light continuation skipped it) and review-round's output, whose lens fields
 *   hold the set a continuation reruns. The lenses this round ran, their union,
 *   are recorded beside the report as the next round's lens set.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { upsertComment, viewPr } from '../../.shared/pr.ts';
import { forgeSource, record, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';
import { parseReviewTarget, reviewHead, reviewMergeBase } from '../../.shared/review-target.ts';
import { REVIEW_LENSES } from '../../.shared/review-policy.ts';

const MARKER = '<!-- archon-review-report -->';

/** The lenses this round ran: the route agent's selection together with review-round's. */
function lenses(): Record<string, boolean> {
  const route = record(JSON.parse(text(process.env.INPUTS_ROUTE) || 'null'));
  const mode = record(JSON.parse(text(process.env.INPUTS_MODE)));
  return Object.fromEntries(
    REVIEW_LENSES.map(lens => [lens, route?.[lens] === true || mode?.[lens] === true])
  );
}

function label(pr: QualifiedPr): string {
  return `${pr.repo.host}/${pr.repo.path}#${String(pr.number)}`;
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
  const target = parseReviewTarget(text(process.env.INPUTS_TARGET));
  const pr = target.pr;
  const head = text(process.env.INPUTS_HEAD).trim();
  if (target.head !== head) throw new Error("review target does not match this round's head");
  const reportPath = text(process.env.INPUTS_REPORT);
  const report = readFileSync(reportPath, 'utf8');
  if (report.trim() === '') throw new Error('the review report is empty');
  const checkout = nodeStartCommit();
  if (checkout !== head) {
    throw new Error(`this round reviewed ${head}, but the checkout is now at ${checkout}`);
  }
  if (!pr) {
    note('publish-review: the review scope is a working diff, so no comment was published.');
  } else {
    const live = viewPr(pr, source).pr;
    const remote = reviewHead(live);
    if (remote !== head) {
      throw new Error(
        `this round reviewed ${head}, but ${label(pr)} is at ${remote}: the commits under review were not pushed`
      );
    }
    if (reviewMergeBase(live, head) !== target.merge_base) {
      throw new Error(`${label(pr)} effective PR diff changed after scope; review the new diff`);
    }
    const comment = upsertComment(
      { kind: 'pr', ref: pr },
      MARKER,
      `${MARKER}\nReviewed commit: \`${head}\`\n\n${report}`,
      source
    );
    note(`publish-review: canonical review comment at ${comment.url}`);
  }
  // review-round reads these as the next round's cursor and lens set.
  writeFileSync(join(dirname(reportPath), 'reviewed-head'), `${head}\n`);
  writeFileSync(join(dirname(reportPath), 'reviewed-lenses.json'), JSON.stringify(lenses()));
  emit(verdict);
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}
