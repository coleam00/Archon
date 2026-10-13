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
 * (review-round): the checkout must still be at it, the pull request's remote
 * head must be it. Any mismatch refuses, so a verdict about one commit can
 * never stand as the verdict on another. A report that does not repeat the SHA
 * is stamped with it, not refused: the round, not the prose, fixes the commit. Once
 * published, the commit is recorded beside the report as the next round's cursor.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_SCOPE: the review's requested scope. Delivery passes its verified
 *   pull-request record here, and that record is then the only write target.
 * - INPUTS_PR: the qualified pull request the scope agent declared it reviewed,
 *   or `null` for a working diff. It names the target of a standalone review.
 * - INPUTS_REPORT: path to the report this node publishes.
 * - INPUTS_HEAD: the commit this round reviewed, as review-round fixed it.
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER: the
 *   certified verdict fields this node forwards.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { upsertComment, viewPr } from '../../.shared/pr.ts';
import {
  forgeSource,
  parseQualifiedPr,
  record,
  sameRepo,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';

const MARKER = '<!-- archon-review-report -->';

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
  const parsed: unknown = JSON.parse(target);
  // Older persisted scope output used `{}` for a working diff.
  if (parsed === null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
    return undefined;
  }
  return parseQualifiedPr(target);
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
  };
  const recorded = recordedPr(text(process.env.INPUTS_SCOPE));
  const declared = declaredPr(text(process.env.INPUTS_PR));
  if (
    recorded &&
    (declared?.number !== recorded.number || !sameRepo(declared.repo, recorded.repo))
  ) {
    throw new Error(
      `the review scope declared ${label(declared)}, but delivery recorded ${label(recorded)}`
    );
  }
  const pr = recorded ?? declared;
  const head = text(process.env.INPUTS_HEAD).trim();
  const reportPath = text(process.env.INPUTS_REPORT);
  const report = readFileSync(reportPath, 'utf8');
  if (report.trim() === '') throw new Error('the review report is empty');
  const checkout = nodeStartCommit();
  if (checkout !== head) {
    throw new Error(`this round reviewed ${head}, but the checkout is now at ${checkout}`);
  }
  // The round fixed the head, so the report is about it whether or not the
  // reviewer's prose repeats the SHA (a short SHA, or none at all). Stamp it rather
  // than refuse a sound review. Only a report that declares another commit refuses.
  const declaredHead = /Reviewed head SHA:\**\s*`?([^\s`*]+)/i.exec(report)?.[1];
  if (!report.includes(head) && declaredHead && !head.startsWith(declaredHead)) {
    throw new Error(
      `the review report says it reviewed ${declaredHead}, but this round reviewed ${head}`
    );
  }
  const stamped = report.includes(head) ? report : `**Reviewed head SHA:** ${head}\n\n${report}`;
  if (stamped !== report) {
    writeFileSync(reportPath, stamped);
    note(`publish-review: the report did not name ${head}; stamped it.`);
  }
  if (!pr) {
    note('publish-review: the review scope is a working diff, so no comment was published.');
  } else {
    const remote = viewPr(pr, source).pr.head_revision;
    if (remote !== head) {
      throw new Error(
        `this round reviewed ${head}, but ${label(pr)} is at ${remote ?? 'an unknown head'}`
      );
    }
    const directory = mkdtempSync(join(tmpdir(), 'archon-review-'));
    try {
      const marked = join(directory, 'comment.md');
      writeFileSync(marked, `${MARKER}\n${stamped}`);
      const comment = upsertComment(pr, MARKER, marked, source);
      note(`publish-review: canonical review comment at ${comment.url}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  // review-round reads this as the next round's cursor.
  writeFileSync(join(dirname(reportPath), 'reviewed-head'), `${head}\n`);
  emit(verdict);
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}
