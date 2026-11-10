/**
 * Send the issues of merged build items back to intake when the merge left them open.
 *
 * A pull request that links its issue with `Refs #N` merges without closing it, and the
 * issue keeps its old stage, so the build queue could claim it again. Each such issue
 * gets this run's re-triage request and one intake pickup; intake decides whether the
 * work is delivered or something is still open. The issue's state is read from the
 * tracker after the merge, so one the merge closed is left alone. Without
 * `retriage_merged` on, nothing is re-triaged.
 *
 * A failed read, request or launch is reported for that issue and the rest still go;
 * the merge record is already written.
 *
 * Bound inputs: INPUTS_ITEMS and INPUTS_SETTLED from facts, INPUTS_MERGED from record,
 * and the workflow input INPUTS_RETRIAGE_MERGED.
 */

import type { QualifiedPr } from '../../.shared/forge.ts';
import { emit, note, nullableJson, refuse, trimmed, workflowRunId } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { requestRetriage } from '../../.shared/launch.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

type Facts = NodeOutput<'archon-merge-queue', 'facts'>;

/** The intake run's id, or null when the issue is closed. */
function retriage(issue: QualifiedPr, runId: string): string | null {
  if (viewIssue(issue).state !== 'open') return null;
  return requestRetriage(issue, runId);
}

function main(): void {
  if (trimmed(process.env.INPUTS_RETRIAGE_MERGED) !== 'true') {
    emit<NodeOutput<'archon-merge-queue', 'retriage'>>({ retriaged: [], summary: 'retriage_merged is off; no merged issue is re-triaged.' });
    return;
  }
  const runId = workflowRunId();
  const items = (nullableJson(process.env.INPUTS_ITEMS) ?? []) as Facts['items'];
  const settled = (nullableJson(process.env.INPUTS_SETTLED) ?? []) as Facts['settled'];
  const merged = new Set((nullableJson(process.env.INPUTS_MERGED) ?? []) as NodeOutput<'archon-merge-queue', 'record'>['merged']);
  const done = [
    ...items.filter(entry => merged.has(entry.pr.number)),
    ...settled.filter(entry => entry.status === 'merged'),
  ].flatMap(({ item, pr }) => (pr === null ? [] : [{ issue: item, pr }]));

  const retriaged: number[] = [];
  const lines: string[] = [];
  for (const { issue, pr } of done) {
    const name = `issue ${String(issue.number)}`;
    try {
      const intake = retriage(issue, runId);
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
  emit<NodeOutput<'archon-merge-queue', 'retriage'>>({ retriaged, summary: [summary, ...lines].join('\n') });
}

try {
  main();
} catch (error) {
  refuse(`merge-queue retriage: ${error instanceof Error ? error.message : String(error)}`);
}
