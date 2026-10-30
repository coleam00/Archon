/**
 * File the issues the slice agent listed, each exactly once, and finish the split.
 *
 * Each issue's body begins with its hidden marker, `<!-- archon-split: <item> <key> -->`,
 * and ends with a `Depends on: #n` line per dependency. A key the work item already
 * records is not filed again; any other is created or, when an earlier attempt filed
 * it before stopping, recovered by its marker. Each filed issue is recorded on the
 * work item before the next is filed, so a rerun after a stop files none twice.
 *
 * Then the item gets one marked comment listing its issues. A PRD is labelled
 * `archon-prd` and stays open until its hypothesis has a verdict; a bundle is closed
 * as completed. The last write records the split done and releases the claim, so a
 * run that stops before it is retried, and every write before it repeats safely.
 *
 * On `idle` this reports what is stuck; on `closed` it records that the item's issue
 * was closed before a split finished, files nothing, and releases the claim.
 */

import { forgeSource, parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { closeIssue, createIssue } from '../../.shared/issue.ts';
import { writeLabels } from '../../.shared/labels.ts';
import { upsertComment } from '../../.shared/pr.ts';
import { type SplitIssue, type SplitRecord, splitMarker } from '../../.shared/split.ts';
import { idleSummary, stuckItems } from '../../.shared/stuck.ts';
import { newest, readWorkItem, updateClaimed, type WorkItem } from '../../.shared/workitem.ts';

/** One issue as the slice node's schema certified it. */
interface Planned {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly size: string;
  readonly depends_on: readonly string[];
}

type Split =
  | { readonly kind: 'prd'; readonly signal_command: string; readonly window_days: number }
  | { readonly kind: 'bundle' };

const COMMENT_MARKER = '<!-- archon-split -->';

function filedOn(doc: WorkItem | null): readonly SplitIssue[] {
  return doc?.facts.split?.issues ?? [];
}

function finish(
  doc: WorkItem,
  record: SplitRecord,
  runId: string,
  outcome: string,
  summary: string
): WorkItem {
  return {
    ...doc,
    claim: null,
    facts: { ...doc.facts, split: record },
    history: newest([...doc.history, { at: record.at, stage: 'split', run_id: runId, outcome, summary }]),
    links: { runs: newest([...doc.links.runs.filter(id => id !== runId), runId]) },
  };
}

/**
 * What the schema cannot say about the list, checked before the first write: each key
 * names one issue, and a dependency is filed already or listed earlier, so its number
 * exists when the issue that names it is filed.
 */
function unfileable(planned: readonly Planned[], filed: readonly SplitIssue[]): string | null {
  const known = new Set(filed.map(entry => entry.key));
  const listed = new Set<string>();
  for (const entry of planned) {
    if (listed.has(entry.key)) return `key ${entry.key} is listed twice`;
    const missing = entry.depends_on.find(key => !known.has(key) && !listed.has(key));
    if (missing !== undefined) return `${entry.key} depends on ${missing}, which is neither filed nor listed before it`;
    listed.add(entry.key);
  }
  return null;
}

function body(item: number, planned: Planned, numbers: ReadonlyMap<string, number>): string {
  const depends = planned.depends_on.map(key => `Depends on: #${String(numbers.get(key))}`).join('\n');
  return [splitMarker(item, planned.key), planned.body.trim(), depends].filter(part => part !== '').join('\n\n');
}

function comment(split: Split, planned: readonly Planned[], numbers: ReadonlyMap<string, number>): string {
  const lines = planned.map(entry => `- #${String(numbers.get(entry.key))} ${entry.title}`);
  const lead =
    split.kind === 'prd'
      ? 'This PRD is split into these issues. It stays open until its hypothesis has a verdict.'
      : 'This bundle of tasks is split into these issues and closed; follow the work there.';
  const measure =
    split.kind === 'prd'
      ? [`The signal is measured with \`${split.signal_command}\`, ${String(split.window_days)} days after release.`]
      : [];
  return [COMMENT_MARKER, lead, lines.join('\n'), ...measure].join('\n\n');
}

function publish(item: QualifiedPr, runId: string, split: Split, planned: readonly Planned[], summary: string): void {
  const at = new Date().toISOString();
  const recorded = (issues: readonly SplitIssue[], status: 'filing' | 'done' = 'filing'): SplitRecord => ({
    status,
    kind: split.kind,
    issues,
    signal_command: split.kind === 'prd' ? split.signal_command : null,
    window_days: split.kind === 'prd' ? split.window_days : null,
    at,
    run_id: runId,
  });
  let issues = filedOn(readWorkItem(item.number));
  const problem = unfileable(planned, issues);
  if (problem !== null) throw new Error(`nothing was filed: ${problem}`);
  const numbers = new Map(issues.map(entry => [entry.key, entry.number]));
  for (const entry of planned) {
    if (numbers.has(entry.key)) continue;
    const marker = splitMarker(item.number, entry.key);
    const created = createIssue(item.repo, entry.title, body(item.number, entry, numbers), marker);
    numbers.set(entry.key, created.issue.number);
    const filed = { key: entry.key, number: created.issue.number, url: created.url };
    const doc = updateClaimed(item, runId, current => ({
      ...current,
      facts: { ...current.facts, split: recorded([...filedOn(current), filed]) },
    }));
    issues = filedOn(doc);
  }

  upsertComment({ kind: 'issue', ref: item }, COMMENT_MARKER, comment(split, planned, numbers), forgeSource());
  if (split.kind === 'prd') writeLabels(item, ['archon-prd'], []);
  else closeIssue(item, 'completed');

  updateClaimed(item, runId, doc => finish(doc, recorded(issues, 'done'), runId, 'split', summary));
  emit({
    path: 'slice',
    item: item.number,
    kind: split.kind,
    issues,
    summary: `Issue ${String(item.number)}: split as a ${split.kind} into ${String(planned.length)} issues; ${summary}`,
  });
}

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  if (path === 'idle') {
    const summary = idleSummary('No item waits for the split queue.', stuckItems(runId));
    emit({ path, item: null, kind: null, issues: [], summary });
    return;
  }
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  if (path === 'closed') {
    const at = new Date().toISOString();
    const reason = 'the issue is closed; nothing more is filed from it';
    const doc = updateClaimed(item, runId, current =>
      finish(current, { status: 'closed', issues: filedOn(current), at, run_id: runId }, runId, 'closed', reason)
    );
    emit({ path, item: item.number, kind: null, issues: filedOn(doc), summary: `Issue ${String(item.number)}: ${reason}` });
    return;
  }
  const split = nullableJson(process.env.INPUTS_SPLIT) as Split | null;
  const planned = nullableJson(process.env.INPUTS_ISSUES) as Planned[] | null;
  if (path !== 'slice' || split === null || planned === null) throw new Error(`the ${path} path reached publish with no split`);
  publish(item, runId, split, planned, text(process.env.INPUTS_SUMMARY));
}

try {
  main();
} catch (error) {
  refuse(`split publish: ${error instanceof Error ? error.message : String(error)}`);
}
