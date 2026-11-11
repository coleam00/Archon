/**
 * Apply the facts node's decision: write the work item first, then the labels that
 * mirror it, then close an item triage found resolved, then release the claim. A
 * close is checked before the first write; one the forge refuses leaves the item
 * BLOCKED for a maintainer instead. A closed issue gets the document write only.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEM and INPUTS_DECISION from facts; INPUTS_TRIAGE,
 * the triage node's typed output, "null" when triage did not run.
 */

import { type ClosePlan, planClose } from '../../.shared/close.ts';
import { parseQualifiedPr, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed, workflowRunId } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { idleSummary, stuckItems } from '../../.shared/stuck.ts';
import { type LabelVerdict, isPackLabel, type PackLabel, triageLabels, wantedLabels, writeLabels } from '../../.shared/labels.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';
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

/** Triage's verdict from its node's typed output, or null when triage did not run on this path. */
function triageResult(): TriageResult | null {
  const triage = nullableJson(process.env.INPUTS_TRIAGE) as NodeOutput<'archon-triage-block', 'triage'> | null;
  if (triage === null) return null;
  const { decision } = triage;
  return {
    verdict: decision.contract === 'READY' ? { contract: 'READY', route: decision.route } : { contract: decision.contract },
    pull_request: 'pull_request' in decision ? decision.pull_request : null,
    type: triage.type,
    size: triage.size,
    complexity: triage.complexity,
    importance: triage.importance,
    urgency: triage.urgency,
    related: triage.related,
    closure: decision.contract === 'NO_ACTION' ? decision.closure : null,
    labels: triageLabels(triage),
    summary: triage.summary,
    report: triage.report,
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
      ...triage.labels.filter(name => !isPackLabel(name)),
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
): { add: readonly string[]; remove: PackLabel[] } | null {
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
      .filter(isPackLabel)
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
      summary: idleSummary('No item waits for intake.', stuckItems(text(process.env.WORKFLOW_ID))),
    });
    return;
  }
  const runId = workflowRunId();
  const item = parseQualifiedPr(process.env.INPUTS_ITEM);
  const decision = nullableJson(process.env.INPUTS_DECISION) as IntakeDecision | null;
  if (decision === null) throw new Error('facts claimed an item and decided nothing for it');
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
