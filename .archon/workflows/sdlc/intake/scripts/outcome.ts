/**
 * Apply the facts node's decision: write the work item first, then the labels that
 * mirror it, then close an item triage found resolved, then release the claim. A
 * closed issue gets the document write only. In eval mode nothing is read or
 * written: the decision is applied to a fresh item in memory and reported, with the
 * label delta live would write, as `evaluation`.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEM, INPUTS_DECISION and INPUTS_SEEN from facts;
 * triage's verdict fields, each "null" when triage did not run; the workflow's
 * INPUTS_MODE and INPUTS_TRUST.
 */

import { type Closure, closeResolved } from '../../.shared/close.ts';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import {
  type Contract,
  type LabelVerdict,
  isOwnedLabel,
  type OwnedLabel,
  type Route,
  writeLabels,
} from '../../.shared/labels.ts';
import {
  applyDecision,
  assertNoSelfPromotion,
  bodyDigest,
  type IntakeDecision,
  mirrorLabels,
  newWorkItem,
  parseMode,
  parseTrustInput,
  type TriageResult,
  updateClaimed,
  type WorkItem,
} from '../../.shared/workitem.ts';

/** Triage's verdict, or null when triage did not run on this path. */
function triageResult(): TriageResult | null {
  const contract = nullableJson(process.env.INPUTS_CONTRACT) as Contract | null;
  if (contract === null) return null;
  const route = nullableJson(process.env.INPUTS_ROUTE) as Route;
  const verdict: LabelVerdict = contract === 'READY' ? { contract, route } : { contract };
  return {
    verdict,
    pull_request: nullableJson(process.env.INPUTS_PULL_REQUEST) as number | null,
    type: nullableJson(process.env.INPUTS_TYPE) as TriageResult['type'],
    size: nullableJson(process.env.INPUTS_SIZE) as TriageResult['size'],
    complexity: nullableJson(process.env.INPUTS_COMPLEXITY) as TriageResult['complexity'],
    importance: nullableJson(process.env.INPUTS_IMPORTANCE) as TriageResult['importance'],
    urgency: nullableJson(process.env.INPUTS_URGENCY) as TriageResult['urgency'],
    closure: nullableJson(process.env.INPUTS_CLOSURE) as Closure | null,
    labels: nullableJson(process.env.INPUTS_LABELS) as string[],
    summary: nullableJson(process.env.INPUTS_SUMMARY) as string,
    report: nullableJson(process.env.INPUTS_REPORT) as TriageResult['report'],
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

/** Everything triage decided, for the eval output; null when triage did not run. */
function evaluatedTriage(triage: TriageResult | null): Record<string, unknown> | null {
  if (triage === null) return null;
  const { verdict, ...fields } = triage;
  return {
    contract: verdict.contract,
    route: nullableJson(process.env.INPUTS_ROUTE),
    ...fields,
    proposed_edits: nullableJson(process.env.INPUTS_PROPOSED_EDITS),
    blocked_reason: nullableJson(process.env.INPUTS_BLOCKED_REASON),
    blocked_by: nullableJson(process.env.INPUTS_BLOCKED_BY),
  };
}

function summary(item: QualifiedPr, next: WorkItem, runId: string): string {
  const latest = next.history.at(-1);
  return `Issue ${String(item.number)}: ${next.stage}${latest?.run_id === runId ? `; ${latest.summary}` : ''}`;
}

function main(): void {
  const mode = parseMode(text(process.env.INPUTS_MODE));
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
      evaluation: null,
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

  if (mode === 'eval') {
    const next = applyDecision(newWorkItem(item, at), decision, triage, false, at, runId);
    const delta = labelDelta(next, decision, triage, false) ?? { add: [], remove: [] };
    emit({
      path: decision.path,
      item: item.number,
      stage: next.stage,
      trust: next.trust,
      promoted: next.promoted !== null,
      labels: [...new Set(delta.add)].sort(),
      summary: summary(item, next, runId),
      evaluation: {
        trust_input: parseTrustInput(text(process.env.INPUTS_TRUST)),
        seen: nullableJson(process.env.INPUTS_SEEN),
        labels: delta,
        reasons: next.history.filter(entry => entry.run_id === runId),
        triage: evaluatedTriage(triage),
      },
    });
    return;
  }

  // A promotion pins the body; an edit while triage ran leaves the verdict judging
  // text no maintainer promoted.
  const bodyMoved =
    decision.path === 'triage' &&
    decision.trust === 'outside' &&
    bodyDigest(viewIssue(item).body) !== decision.body_digest;
  const next = updateClaimed(item, runId, doc =>
    applyDecision(doc, decision, triage, bodyMoved, at, runId)
  );

  const delta = labelDelta(next, decision, triage, bodyMoved);
  const labels = delta === null ? [] : writeLabels(item, delta.add, delta.remove);
  // A demoted item's verdict judged text no maintainer promoted, so it closes nothing.
  if (!bodyMoved && triage?.closure) closeResolved(item, triage.closure);
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
    evaluation: null,
  });
}

try {
  main();
} catch (error) {
  refuse(`intake outcome: ${error instanceof Error ? error.message : String(error)}`);
}
