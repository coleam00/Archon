/**
 * Record this run's event on its issue, claim that issue, or the best waiting item when
 * it does not wait, and decide what the claimed item needs before any model reads its text.
 *
 * Trust is one fact read here: is the issue's author on the project's maintainer list.
 * A label request counts only when its actor, as the forge event reported it, is on
 * that list. The run's only writes are the request and the claim.
 */

import { emit, input, refuse, runId as workflowRunId } from 'archon:script';
import { viewIssue } from '../../.shared/issue.ts';
import { TRIAGE_REQUEST } from '../../.shared/labels.ts';
import {
  bodyDigest,
  claimable,
  claimItem,
  claimNext,
  decideIntake,
  enqueue,
  INTAKE_PICKUP,
  type IntakeRequest,
  read,
  REQUEST_ACTIONS,
  type RequestAction,
  type WorkItem,
  workItemName,
} from '../../.shared/workitem.ts';
import { readMaintainers } from '../../.shared/maintainers.ts';
import { workflowRepo } from '../../.shared/remote.ts';

/**
 * Claim the issue this run's event names when it waits, else the best waiting item.
 * Events that arrive together each start a run, and a run that took another event's
 * issue would leave its own to a run that may already have looked and found nothing:
 * the last issue would wait with no run left to triage it.
 */
function claim(kind: string, number: number, at: string, runId: string): WorkItem | null {
  const own = kind === 'issue' ? read(workItemName(number)) : undefined;
  return (claimable(own, INTAKE_PICKUP) ? claimItem(own, at, runId) : null) ?? claimNext(at, runId);
}

function main(): void {
  const runId = workflowRunId();
  const number = Number(input('number').trim());
  if (!Number.isInteger(number) || number <= 0) throw new Error('a positive issue number is required');
  const repo = workflowRepo();
  const action = input('action').trim() as RequestAction;
  if (!REQUEST_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${REQUEST_ACTIONS.join(', ')}, not "${action}"`);
  }
  // Read before any write, so a broken list refuses the run with nothing recorded.
  const maintainers = readMaintainers(repo);
  const at = new Date().toISOString();
  const subject = { repo, number };
  const label = input('label').trim();
  // Intake works issues. A pull request's event, or a label that asks for nothing,
  // records no request; the run still picks up whatever waits. A run that asks for a
  // re-triage recorded its own request before starting this pickup.
  const kind = input('kind').trim();
  if (kind === 'issue' && action !== 'retriage' && (action !== 'added' || label === TRIAGE_REQUEST)) {
    const request: IntakeRequest = {
      at,
      run_id: runId,
      action,
      label: action === 'added' ? label : null,
      actor: action === 'added' ? input('label_actor').trim() || null : null,
      // A promotion pins the body as it was when the request was recorded.
      body_digest: action === 'added' ? bodyDigest(viewIssue(subject).body) : null,
    };
    enqueue(subject, request);
  }

  const doc = claim(kind, number, at, runId);
  if (doc === null) {
    emit({ path: 'idle', item: null, target: '', decision: null });
    return;
  }
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
