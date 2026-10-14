/**
 * Apply the facts node's decision: write the work item first, then the labels that
 * mirror it, then release the claim. A closed issue gets the document write only.
 *
 * Bound inputs: INPUTS_PATH, INPUTS_ITEM and INPUTS_DECISION from facts; triage's
 * verdict fields, each "null" when triage did not run.
 */

import { parseQualifiedPr } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import {
  type Contract,
  type LabelVerdict,
  isOwnedLabel,
  type Route,
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
    labels: nullableJson(process.env.INPUTS_LABELS) as string[],
    summary: nullableJson(process.env.INPUTS_SUMMARY) as string,
    report: nullableJson(process.env.INPUTS_REPORT) as TriageResult['report'],
  };
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
  const next = updateClaimed(item, runId, doc =>
    applyDecision(doc, decision, triage, bodyMoved, at, runId)
  );

  // A closed issue's labels are left as they are.
  let labels: string[] = [];
  if (decision.path !== 'closed') {
    const add: readonly string[] =
      decision.path === 'triage' && !bodyMoved && triage !== null
        ? triage.labels
        : mirrorLabels(next);
    assertNoSelfPromotion(next, add);
    // Only labels on the issue at pickup: one added while this run worked is a request
    // the next pickup reads, even before its own run has queued it.
    labels = writeLabels(
      item,
      add,
      decision.labels.filter(isOwnedLabel).filter(name => !add.includes(name))
    );
  }
  // Clearing the claim is what marks this run's requests honored; a run that stops
  // before it leaves them for the next pickup to queue again.
  updateClaimed(item, runId, doc => ({ ...doc, claim: null }));

  const latest = next.history.at(-1);
  emit({
    path: decision.path,
    item: item.number,
    stage: next.stage,
    trust: next.trust,
    promoted: next.promoted !== null,
    labels,
    summary: `Issue ${String(item.number)}: ${next.stage}${latest?.run_id === runId ? `; ${latest.summary}` : ''}`,
  });
}

try {
  main();
} catch (error) {
  refuse(`intake outcome: ${error instanceof Error ? error.message : String(error)}`);
}
