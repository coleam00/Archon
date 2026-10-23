/**
 * Send the issues of merged build items back to intake when the merge left them open.
 *
 * A pull request that links its issue with `Refs #N` merges without closing it, and the
 * issue keeps its old stage, so the build queue could claim it again. Each such issue
 * gets `archon-triage` and a detached intake run with that label event, recorded as
 * added by `retriage_as`; intake decides whether the work is delivered or something is
 * still open. The issue's state is read from the tracker after the merge, so one the
 * merge closed is left alone. An enrolled own pull request's work item is the pull
 * request itself: it has no issue. Empty `retriage_as` re-triages nothing.
 *
 * A failed read, label write or launch is reported for that issue and the rest still
 * go; the merge record is already written.
 *
 * Bound inputs: INPUTS_ITEMS and INPUTS_SETTLED from facts, INPUTS_MERGED from record,
 * and the workflow input INPUTS_RETRIAGE_AS.
 */

import { type QualifiedPr, samePr } from '../../.shared/forge.ts';
import { emit, note, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { launchDetached } from '../../.shared/launch.ts';
import { writeLabels } from '../../.shared/labels.ts';
import type { MergeSettled } from '../../.shared/merge.ts';

interface Item {
  readonly item: QualifiedPr | null;
  readonly pr: QualifiedPr;
}

/** The intake run's id, or null when the issue is closed. */
function retriage(issue: QualifiedPr, actor: string): string | null {
  if (viewIssue(issue).state !== 'open') return null;
  writeLabels(issue, ['archon-triage'], []);
  return launchDetached('archon-intake', {
    repo_host: issue.repo.host,
    repo_path: issue.repo.path,
    number: String(issue.number),
    action: 'added',
    label: 'archon-triage',
    label_actor: actor,
  });
}

function main(): void {
  const actor = trimmed(process.env.INPUTS_RETRIAGE_AS);
  if (actor === '') {
    emit({ retriaged: [], summary: 'retriage_as is empty; no merged issue is re-triaged.' });
    return;
  }
  const items = (nullableJson(process.env.INPUTS_ITEMS) ?? []) as Item[];
  const settled = (nullableJson(process.env.INPUTS_SETTLED) ?? []) as MergeSettled[];
  const merged = new Set((nullableJson(process.env.INPUTS_MERGED) ?? []) as number[]);
  const done = [
    ...items.filter(entry => merged.has(entry.pr.number)),
    ...settled.filter(entry => entry.status === 'merged'),
  ].flatMap(({ item, pr }) => (item === null || pr === null || samePr(item, pr) ? [] : [{ issue: item, pr }]));

  const retriaged: number[] = [];
  const lines: string[] = [];
  for (const { issue, pr } of done) {
    const name = `issue ${String(issue.number)}`;
    try {
      const intake = retriage(issue, actor);
      if (intake === null) {
        lines.push(`${name}: closed after PR ${String(pr.number)} merged`);
        continue;
      }
      retriaged.push(issue.number);
      lines.push(`${name}: still open after PR ${String(pr.number)} merged; asked intake to re-triage (run ${intake})`);
    } catch (error) {
      const failure = `${name}: not re-triaged: ${error instanceof Error ? error.message : String(error)}`;
      note(`merge-queue retriage: ${failure}`);
      lines.push(failure);
    }
  }
  const summary = `Sent ${String(retriaged.length)} of ${String(done.length)} merged issue(s) back to intake.`;
  emit({ retriaged, summary: [summary, ...lines].join('\n') });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue retriage: ${error instanceof Error ? error.message : String(error)}`);
}
