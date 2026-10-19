/**
 * Apply the facts node's decision: write the work item first, then the labels that
 * mirror it, then close an item triage found resolved, then release the claim. A
 * close is checked before the first write; one the forge refuses leaves the item
 * BLOCKED for a maintainer instead. A closed issue gets the document write only.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEM and INPUTS_DECISION from facts; triage's
 * verdict fields, each "null" when triage did not run.
 */

import { type Closure, type ClosePlan, planClose } from '../../.shared/close.ts';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import {
  type Contract,
  type LabelVerdict,
  isOwnedLabel,
  type OwnedLabel,
  type Route,
  wantedLabels,
  writeLabels,
} from '../../.shared/labels.ts';
import {
  applyDecision,
  assertNoSelfPromotion,
  bodyDigest,
  type IntakeDecision,
  mirrorLabels,
  type TriageResult,
  updateClaimed,
  type WorkItem,
} from '../../.shared/workitem.ts';

/**
 * A string field of triage's verdict, or null when triage did not run. The engine
 * binds a string raw, not as JSON, and a skipped producer's `if_skipped: null` as
 * the text `null`.
 */
function verdictText(value: string | undefined): string | null {
  const raw = text(value);
  return raw === 'null' ? null : raw;
}

/** Triage's verdict, or null when triage did not run on this path. */
function triageResult(): TriageResult | null {
  const contract = verdictText(process.env.INPUTS_CONTRACT) as Contract | null;
  if (contract === null) return null;
  const route = verdictText(process.env.INPUTS_ROUTE) as Route;
  const closure = nullableJson(process.env.INPUTS_CLOSURE) as Closure | null;
  // A missing binding reads as null; a NO_ACTION verdict without its closure would
  // label the item for a close that never happens.
  if ((contract === 'NO_ACTION') !== (closure !== null)) {
    throw new Error('a NO_ACTION verdict, and only that one, carries a closure');
  }
  const verdict: LabelVerdict = contract === 'READY' ? { contract, route } : { contract };
  return {
    verdict,
    pull_request: nullableJson(process.env.INPUTS_PULL_REQUEST) as number | null,
    type: nullableJson(process.env.INPUTS_TYPE) as TriageResult['type'],
    size: nullableJson(process.env.INPUTS_SIZE) as TriageResult['size'],
    complexity: nullableJson(process.env.INPUTS_COMPLEXITY) as TriageResult['complexity'],
    importance: nullableJson(process.env.INPUTS_IMPORTANCE) as TriageResult['importance'],
    urgency: nullableJson(process.env.INPUTS_URGENCY) as TriageResult['urgency'],
    closure,
    labels: nullableJson(process.env.INPUTS_LABELS) as string[],
    summary: text(process.env.INPUTS_SUMMARY),
    report: nullableJson(process.env.INPUTS_REPORT) as TriageResult['report'],
  };
}

/** Triage's closable verdict as a BLOCKED one, when the close it declared was refused. */
function leftToMaintainer(triage: TriageResult, refused: string): TriageResult {
  const verdict: LabelVerdict = { contract: 'BLOCKED' };
  return {
    ...triage,
    verdict,
    closure: null,
    labels: [
      ...wantedLabels(verdict, triage.type.value, triage.size.value),
      ...triage.labels.filter(name => !isOwnedLabel(name)),
    ],
    summary: `${triage.summary} The close was refused: ${refused}; a maintainer decides.`,
  };
}

/**
 * The labels this outcome adds and removes; null for a closed issue, whose labels are
 * left as they are.
 */
function labelDelta(
  next: WorkItem,
  decision: IntakeDecision,
  triage: TriageResult | null,
  bodyMoved: boolean
): { add: readonly string[]; remove: OwnedLabel[] } | null {
  if (decision.path === 'closed') return null;
  const add: readonly string[] =
    decision.path === 'triage' && !bodyMoved && triage !== null
      ? triage.labels
      : mirrorLabels(next);
  assertNoSelfPromotion(next, add);
  // A request label added again after this run claimed its request is the next
  // pickup's to read, when its new request already waits in next.requests.
  const requested = new Set(next.requests.map(request => request.label));
  return {
    add,
    remove: decision.labels
      .filter(isOwnedLabel)
      .filter(name => !add.includes(name) && !requested.has(name)),
  };
}

function summary(item: QualifiedPr, next: WorkItem, runId: string): string {
  const latest = next.history.at(-1);
  return `Issue ${String(item.number)}: ${next.stage}${latest?.run_id === runId ? `; ${latest.summary}` : ''}`;
}

function main(): void {
  const path = trimmed(process.env.INPUTS_PATH);
  if (path === 'idle') {
    emit({
      path,
      item: null,
      stage: null,
      trust: null,
      promoted: false,
      labels: [],
      summary: 'No item waits for intake.',
    });
    return;
  }
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '')
    throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const decision = nullableJson(process.env.INPUTS_DECISION) as IntakeDecision;
  const triage = triageResult();
  const at = new Date().toISOString();

  // A promotion pins the body; an edit while triage ran leaves the verdict judging
  // text no maintainer promoted.
  const bodyMoved =
    decision.path === 'triage' &&
    decision.trust === 'outside' &&
    bodyDigest(viewIssue(item).body) !== decision.body_digest;
  // A demoted item's verdict judged text no maintainer promoted, so it closes nothing.
  let close: ClosePlan | null = null;
  let judged = triage;
  if (!bodyMoved && triage?.closure) {
    close = planClose(item, triage.closure);
    if (close.refused !== null) judged = leftToMaintainer(triage, close.refused);
  }
  const next = updateClaimed(item, runId, doc =>
    applyDecision(doc, decision, judged, bodyMoved, at, runId)
  );

  const delta = labelDelta(next, decision, judged, bodyMoved);
  const labels = delta === null ? [] : writeLabels(item, delta.add, delta.remove);
  if (close !== null && close.refused === null) close.close();
  // Clearing the claim is what marks this run's requests honored; a run that stops
  // before it leaves them for the next pickup to queue again.
  updateClaimed(item, runId, doc => ({ ...doc, claim: null }));

  emit({
    path: decision.path,
    item: item.number,
    stage: next.stage,
    trust: next.trust,
    promoted: next.promoted !== null,
    labels,
    summary: summary(item, next, runId),
  });
}

try {
  main();
} catch (error) {
  refuse(`intake outcome: ${error instanceof Error ? error.message : String(error)}`);
}
