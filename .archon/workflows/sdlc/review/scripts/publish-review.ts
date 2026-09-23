/**
 * Publish the review report as the pull request's one canonical comment.
 *
 * The reviewer judges and writes the report; this node owns the public write, so
 * every round edits the same marked comment instead of appending another. A
 * review whose scope was a working diff has no pull request and publishes
 * nothing. The verdict passes through unchanged either way: publication is not
 * what makes a review true.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_PR: the qualified pull request this round reviewed, or `{}` for a
 *   working diff.
 * - INPUTS_REPORT: path to the report this node publishes.
 * - INPUTS_READY / INPUTS_ACTION / INPUTS_SUMMARY / INPUTS_REPORT_POINTER: the
 *   certified verdict fields this node forwards.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertComment } from '../../.shared/pr.ts';
import { forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';

const MARKER = '<!-- archon-review-report -->';

try {
  const source = forgeSource(process.env.ARCHON_SDLC_FORGE);
  const verdict = {
    ready: JSON.parse(text(process.env.INPUTS_READY)) as boolean,
    action: text(process.env.INPUTS_ACTION),
    findings_summary: text(process.env.INPUTS_SUMMARY),
    report: JSON.parse(text(process.env.INPUTS_REPORT_POINTER)) as unknown,
  };
  const target = text(process.env.INPUTS_PR).trim() || '{}';
  const parsed: unknown = JSON.parse(target);
  if (parsed === null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
    note('publish-review: the review scope is a working diff, so no comment was published.');
    emit(verdict);
  } else {
    const pr = parseQualifiedPr(target);
    const directory = mkdtempSync(join(tmpdir(), 'archon-review-'));
    try {
      const marked = join(directory, 'comment.md');
      const report = readFileSync(text(process.env.INPUTS_REPORT), 'utf8');
      if (report.trim() === '') throw new Error('the review report is empty');
      writeFileSync(marked, `${MARKER}\n${report}`);
      const comment = upsertComment(pr, MARKER, marked, source);
      note(`publish-review: canonical review comment at ${comment.url}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    emit(verdict);
  }
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}
