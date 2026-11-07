/**
 * File the issues for the item's current phase, each exactly once, and finish the split.
 *
 * Each issue's body begins with its hidden marker, `<!-- archon-split: <item> <key> -->`.
 * A key the work item already records is not filed again; any other is created or,
 * when an earlier attempt filed it before stopping, recovered by its marker. Each filed
 * issue is recorded on the work item before the next is filed, so a rerun after a stop
 * files none twice. The existing issues the agent listed instead of filing are read to
 * prove each is an open issue of the repository, and recorded beside the filed ones.
 *
 * Then the item gets one marked comment listing its issues and the later phases the
 * agent planned, which are not filed yet. A PRD is labelled `archon-prd` and stays open
 * until its hypothesis has a verdict; an epic stays open until its increments merge; a
 * bundle is closed as completed. The last write records the split done and releases
 * the claim, so a run that stops before it is retried, and every write before it
 * repeats safely.
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
  adoptedIssues,
  filedIssues,
  type SplitIssue,
  type SplitKind,
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
}

/** A later phase, recorded on the item and not filed yet. */
interface Later {
  readonly title: string;
  readonly signal: string;
}

/** An existing issue the agent listed instead of filing. */
interface Existing {
  readonly number: number;
  readonly why: string;
}

type Answer = { readonly kind: SplitKind } | { readonly kind: 'whole'; readonly route: WholeRoute };

const COMMENT_MARKER = '<!-- archon-split -->';

const LEAD: Record<SplitKind, string> = {
  prd: "This PRD's current phase is filed as these issues. It stays open until its hypothesis has a verdict.",
  epic: "This epic's current increment is filed as these issues. It stays open until its increments merge.",
  bundle: 'This bundle of tasks is filed as these issues and closed; follow the work there.',
};

function filedOn(doc: WorkItem | null): readonly SplitIssue[] {
  return filedIssues(doc?.facts.split);
}

function finish(doc: WorkItem, record: SplitRecord, runId: string, outcome: string, summary: string): WorkItem {
  return {
    ...doc,
    claim: null,
    facts: { ...doc.facts, split: record },
    history: newest([...doc.history, { at: record.at, stage: 'split', run_id: runId, outcome, summary }]),
    links: { runs: newest([...doc.links.runs.filter(id => id !== runId), runId]) },
  };
}

function comment(kind: SplitKind, issues: readonly SplitIssue[], adopted: readonly AdoptedIssue[], later: readonly Later[]): string {
  const listed = issues.map(entry => `- #${String(entry.number)} ${entry.title}`);
  const tracked = adopted.map(entry => `- #${String(entry.number)} ${entry.why}`);
  const planned = later.map(entry => `- ${entry.title}. Filed once the earlier work shows: ${entry.signal}`);
  return [
    COMMENT_MARKER,
    LEAD[kind],
    listed.join('\n'),
    tracked.length > 0 ? `It also depends on these open issues, which already own part of it:\n${tracked.join('\n')}` : '',
    planned.length > 0 ? `Later phases, not filed yet:\n${planned.join('\n')}` : '',
  ]
    .filter(part => part !== '')
    .join('\n\n');
}

function publish(
  item: QualifiedPr,
  runId: string,
  kind: SplitKind,
  planned: readonly Planned[],
  later: readonly Later[],
  existing: readonly Existing[],
  summary: string
): void {
  const at = new Date().toISOString();
  const recorded = (issues: readonly SplitIssue[], status: 'filing' | 'done' = 'filing'): SplitRecord => ({
    status,
    kind,
    issues,
    adopted,
    at,
    run_id: runId,
  });
  // Two entries under one key would file only the first.
  const keys = planned.map(entry => entry.key);
  const twice = keys.find((key, index) => keys.indexOf(key) !== index);
  if (twice !== undefined) throw new Error(`nothing was filed: key ${twice} is listed twice`);
  const before = readWorkItem(item.number)?.facts.split;
  // viewIssue refuses a number that is not an issue of the repository.
  const listed: AdoptedIssue[] = existing.map(entry => {
    const view = viewIssue({ repo: item.repo, number: entry.number });
    if (view.state !== 'open') throw new Error(`nothing was filed: existing issue ${String(entry.number)} is ${view.state}, not open`);
    return { number: entry.number, url: view.url, why: entry.why };
  });
  // An earlier phase's adoptions stay unless this phase lists the issue again.
  const adopted = [...adoptedIssues(before).filter(entry => !listed.some(next => next.number === entry.number)), ...listed];
  let issues = filedIssues(before);
  for (const entry of planned) {
    if (issues.some(filed => filed.key === entry.key)) continue;
    const marker = splitMarker(item.number, entry.key);
    const created = createIssue(item.repo, entry.title, `${marker}\n\n${entry.body.trim()}`, marker);
    const filed = { key: entry.key, number: created.issue.number, url: created.url, title: entry.title };
    const doc = updateClaimed(item, runId, current => ({
      ...current,
      facts: { ...current.facts, split: recorded([...filedOn(current), filed]) },
    }));
    issues = filedOn(doc);
  }

  upsertComment({ kind: 'issue', ref: item }, COMMENT_MARKER, comment(kind, issues, adopted, later));
  if (kind === 'prd') writeLabels(item, ['archon-prd'], []);
  if (kind === 'bundle') closeIssue(item, 'completed');

  updateClaimed(item, runId, doc => finish(doc, recorded(issues, 'done'), runId, 'split', summary));
  emit({
    path: 'slice',
    item: item.number,
    kind,
    issues,
    adopted,
    summary: `Issue ${String(item.number)}: split as a ${kind}, ${String(planned.length)} issues filed now and ${String(later.length)} later phases planned; ${summary}`,
  });
}

/** Hand the item to the build queue as one work item, with the agent's reason. */
function buildWhole(item: QualifiedPr, runId: string, route: WholeRoute, reason: string): void {
  const at = new Date().toISOString();
  const lead = 'The split queue found this item can be built as one work item, so it files no issues for it.';
  upsertComment({ kind: 'issue', ref: item }, COMMENT_MARKER, [COMMENT_MARKER, lead, reason].join('\n\n'));
  writeLabels(item, [ROUTE_LABEL[route]], ['archon-split']);
  updateClaimed(item, runId, current => ({
    ...finish(current, { status: 'whole', route, at, run_id: runId }, runId, 'whole', reason),
    stage: route,
  }));
  emit({ path: 'slice', item: item.number, kind: 'whole', issues: [], adopted: [], summary: `Issue ${String(item.number)}: built whole at ${route}; ${reason}` });
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
  const answer = nullableJson(process.env.INPUTS_SPLIT) as Answer | null;
  const planned = nullableJson(process.env.INPUTS_ISSUES) as Planned[] | null;
  const later = nullableJson(process.env.INPUTS_LATER) as Later[] | null;
  const existing = nullableJson(process.env.INPUTS_EXISTING) as Existing[] | null;
  if (path !== 'slice' || answer === null || planned === null || later === null || existing === null)
    throw new Error(`the ${path} path reached publish with no split`);
  const summary = text(process.env.INPUTS_SUMMARY);
  if (answer.kind !== 'whole') {
    publish(item, runId, answer.kind, planned, later, existing, summary);
    return;
  }
  if (planned.length > 0 || later.length > 0 || existing.length > 0)
    throw new Error('nothing was filed: an item built whole lists no issues');
  // Pieces an earlier split filed may already be in flight; dropping them is a maintainer's call.
  const filed = filedOn(readWorkItem(item.number));
  if (filed.length > 0) {
    const numbers = filed.map(entry => `#${String(entry.number)}`).join(', ');
    throw new Error(`the item is already split into ${numbers}, so it cannot be built whole`);
  }
  buildWhole(item, runId, answer.route, summary);
}

try {
  main();
} catch (error) {
  refuse(`split publish: ${error instanceof Error ? error.message : String(error)}`);
}
