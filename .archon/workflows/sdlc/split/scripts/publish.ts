/**
 * File the issues the slice agent listed, each exactly once, and finish the split.
 *
 * Each issue's body begins with its hidden marker, `<!-- archon-split: <item> <key> -->`,
 * and ends with a `Depends on: #n` line per dependency. A key the work item already
 * records is not filed again; any other is created or, when an earlier attempt filed
 * it before stopping, recovered by its marker. Each filed issue is recorded on the
 * work item before the next is filed, so a rerun after a stop files none twice. The existing issues the agent listed instead of filing are read to
 * prove each is an issue of the repository, and recorded beside the filed ones.
 *
 * Then the item gets one marked comment listing its issues. A PRD is labelled
 * `archon-prd` and stays open until its hypothesis has a verdict; an epic stays open
 * until its pieces merge; a bundle is closed as completed. The last write records the
 * split done and releases the claim, so a run that stops before it is retried, and
 * every write before it repeats safely.
 *
 * When the agent judged the item one work item after all, nothing is filed: the item
 * gets the same marked comment with why, its route label in place of `archon-split`,
 * and the last write moves it to that build route, where the build queue picks it up.
 * An item an earlier split already filed issues from refuses that answer.
 *
 * On `idle` this reports what is stuck; on `closed` it records that the item's issue
 * was closed before a split finished, files nothing, and releases the claim.
 */

import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { closeIssue, createIssue, viewIssue } from '../../.shared/issue.ts';
import { ROUTE_LABEL, writeLabels } from '../../.shared/labels.ts';
import { upsertComment } from '../../.shared/pr.ts';
import {
  type AdoptedIssue,
  type SplitIssue,
  type SplitRecord,
  splitMarker,
  type WholeRoute,
} from '../../.shared/split.ts';
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

/** An existing issue the agent listed instead of filing. */
interface Existing {
  readonly number: number;
  readonly why: string;
}

type Split =
  | { readonly kind: 'prd'; readonly signal_command: string; readonly window_days: number }
  | { readonly kind: 'epic' | 'bundle' };

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

function comment(
  split: Split,
  planned: readonly Planned[],
  numbers: ReadonlyMap<string, number>,
  adopted: readonly AdoptedIssue[]
): string {
  const lines = planned.map(entry => `- #${String(numbers.get(entry.key))} ${entry.title}`);
  const tracked =
    adopted.length > 0
      ? [`It also depends on these open issues, which already own part of it:\n${adopted.map(entry => `- #${String(entry.number)} ${entry.why}`).join('\n')}`]
      : [];
  const lead = {
    prd: 'This PRD is split into these issues. It stays open until its hypothesis has a verdict.',
    epic: 'This epic is split into these issues. It stays open until they merge.',
    bundle: 'This bundle of tasks is split into these issues and closed; follow the work there.',
  }[split.kind];
  const measure =
    split.kind === 'prd'
      ? [`The signal is measured with \`${split.signal_command}\`, ${String(split.window_days)} days after release.`]
      : [];
  return [COMMENT_MARKER, lead, lines.join('\n'), ...tracked, ...measure].filter(part => part !== '').join('\n\n');
}

function publish(
  item: QualifiedPr,
  runId: string,
  split: Split,
  planned: readonly Planned[],
  existing: readonly Existing[],
  summary: string
): void {
  const at = new Date().toISOString();
  const recorded = (issues: readonly SplitIssue[], status: 'filing' | 'done' = 'filing'): SplitRecord => ({
    status,
    kind: split.kind,
    issues,
    adopted,
    signal_command: split.kind === 'prd' ? split.signal_command : null,
    window_days: split.kind === 'prd' ? split.window_days : null,
    at,
    run_id: runId,
  });
  let issues = filedOn(readWorkItem(item.number));
  const problem = unfileable(planned, issues);
  if (problem !== null) throw new Error(`nothing was filed: ${problem}`);
  // viewIssue refuses a number that is not an issue of the repository.
  const adopted: AdoptedIssue[] = existing.map(entry => {
    const view = viewIssue({ repo: item.repo, number: entry.number });
    if (view.state !== 'open') throw new Error(`nothing was filed: existing issue ${String(entry.number)} is ${view.state}, not open`);
    return { number: entry.number, url: view.url, why: entry.why };
  });
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

  upsertComment({ kind: 'issue', ref: item }, COMMENT_MARKER, comment(split, planned, numbers, adopted));
  if (split.kind === 'prd') writeLabels(item, ['archon-prd'], []);
  if (split.kind === 'bundle') closeIssue(item, 'completed');

  updateClaimed(item, runId, doc => finish(doc, recorded(issues, 'done'), runId, 'split', summary));
  emit({
    path: 'slice',
    item: item.number,
    kind: split.kind,
    issues,
    adopted,
    summary: `Issue ${String(item.number)}: split as a ${split.kind} into ${String(planned.length)} issues; ${summary}`,
  });
}

/** Hand the item to the build queue as one work item, with the agent's reason. */
function buildWhole(item: QualifiedPr, runId: string, route: WholeRoute, reason: string): void {
  const at = new Date().toISOString();
  const lead = 'The split queue found this item can be built as one work item, so it files no issues for it.';
  upsertComment({ kind: 'issue', ref: item }, COMMENT_MARKER, [COMMENT_MARKER, lead, reason].join('\n\n'));
  writeLabels(item, [ROUTE_LABEL[route]], ['archon-split']);
  const doc = updateClaimed(item, runId, current => ({
    ...finish(current, { status: 'whole', route, reason, issues: filedOn(current), at, run_id: runId }, runId, 'whole', reason),
    stage: route,
  }));
  emit({
    path: 'slice',
    item: item.number,
    kind: 'whole',
    issues: filedOn(doc),
    adopted: [],
    summary: `Issue ${String(item.number)}: built whole at ${route}; ${reason}`,
  });
}

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  if (path === 'idle') {
    const summary = idleSummary('No item waits for the split queue.', stuckItems(runId));
    emit({ path, item: null, kind: null, issues: [], adopted: [], summary });
    return;
  }
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  if (path === 'closed') {
    const at = new Date().toISOString();
    const reason = 'the issue is closed; nothing more is filed from it';
    const doc = updateClaimed(item, runId, current =>
      finish(current, { status: 'closed', issues: filedOn(current), at, run_id: runId }, runId, 'closed', reason)
    );
    emit({ path, item: item.number, kind: null, issues: filedOn(doc), adopted: [], summary: `Issue ${String(item.number)}: ${reason}` });
    return;
  }
  const split = nullableJson(process.env.INPUTS_SPLIT) as Split | { kind: 'whole'; route: WholeRoute } | null;
  const planned = nullableJson(process.env.INPUTS_ISSUES) as Planned[] | null;
  const existing = nullableJson(process.env.INPUTS_EXISTING) as Existing[] | null;
  if (path !== 'slice' || split === null || planned === null || existing === null)
    throw new Error(`the ${path} path reached publish with no split`);
  if (split.kind === 'whole') {
    if (planned.length > 0 || existing.length > 0) throw new Error('nothing was filed: an item built whole lists no issues');
    // Pieces an earlier split filed may already be in flight; dropping them is a maintainer's call.
    const filed = filedOn(readWorkItem(item.number));
    if (filed.length > 0) {
      const numbers = filed.map(entry => `#${String(entry.number)}`).join(', ');
      throw new Error(`the item is already split into ${numbers}, so it cannot be built whole`);
    }
    buildWhole(item, runId, split.route, text(process.env.INPUTS_SUMMARY));
    return;
  }
  publish(item, runId, split, planned, existing, text(process.env.INPUTS_SUMMARY));
}

try {
  main();
} catch (error) {
  refuse(`split publish: ${error instanceof Error ? error.message : String(error)}`);
}
