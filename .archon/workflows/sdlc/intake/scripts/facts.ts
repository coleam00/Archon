/**
 * Record this run's event on its issue, claim the best waiting item, and decide what
 * it needs before any model reads its text.
 *
 * Trust is one fact read here: is the issue's author on the project's maintainer list.
 * A label request counts only when its actor, as the forge event reported it, is on
 * that list. The run's only writes are the request, the claim and taking the claimed
 * item's requests.
 */

import { emit, refuse, trimmed, workflowRunId } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { TRIAGE_REQUEST } from '../../.shared/labels.ts';
import {
  bodyDigest,
  claimNext,
  decideIntake,
  enqueue,
  INTAKE_PICKUP,
  type IntakeRequest,
  REQUEST_ACTIONS,
  type RequestAction,
  updateHeld,
  withRequestsTaken,
} from '../../.shared/workitem.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { workflowRepo } from '../../.shared/remote.ts';

function main(): void {
  const runId = workflowRunId();
  const number = Number(trimmed(process.env.INPUTS_NUMBER));
  if (!Number.isInteger(number) || number <= 0) throw new Error('a positive issue number is required');
  const repo = workflowRepo();
  const action = trimmed(process.env.INPUTS_ACTION) as RequestAction;
  if (!REQUEST_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${REQUEST_ACTIONS.join(', ')}, not "${action}"`);
  }
  // Read before any write, so a broken list refuses the run with nothing recorded.
  const maintainers = readMaintainers(repo);
  const at = new Date().toISOString();
  const subject = { repo, number };
  const label = trimmed(process.env.INPUTS_LABEL);
  // Intake works issues. A pull request's event, or a label that asks for nothing,
  // records no request; the run still picks up whatever waits. A run that asks for a
  // re-triage recorded its own request before starting this pickup.
  const kind = trimmed(process.env.INPUTS_KIND);
  if (kind === 'issue' && action !== 'retriage' && (action !== 'added' || label === TRIAGE_REQUEST)) {
    const request: IntakeRequest = {
      at,
      run_id: runId,
      action,
      label: action === 'added' ? label : null,
      actor: action === 'added' ? trimmed(process.env.INPUTS_LABEL_ACTOR) || null : null,
      // A promotion pins the body as it was when the request was recorded.
      body_digest: action === 'added' ? bodyDigest(viewIssue(subject).body) : null,
    };
    enqueue(subject, request);
  }

  const claimed = claimNext(INTAKE_PICKUP);
  if (claimed === null) {
    emit({ path: 'idle', item: null, target: '', decision: null });
    return;
  }
  const doc = updateHeld(claimed.subject, withRequestsTaken);
  const issue = viewIssue(doc.subject);
  const decision = decideIntake(
    doc,
    { ...issue, digest: bodyDigest(issue.body) },
    maintainers,
    at,
    runId
  );
  emit({ path: decision.path, item: doc.subject, target: issue.url, decision });
}

try {
  main();
} catch (error) {
  refuse(`intake facts: ${error instanceof Error ? error.message : String(error)}`);
}
