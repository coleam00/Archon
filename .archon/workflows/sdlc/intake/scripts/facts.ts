/**
 * Record this run's event on its issue, claim the best waiting item, and decide what
 * it needs before any model reads its text.
 *
 * Trust is one fact read here: is the issue's author on the project's maintainer list.
 * A label request counts only when its actor, as the forge event reported it, is on
 * that list. A live run's only writes are the request and the claim. An eval run
 * writes nothing: it decides the named issue as it was at creation, as a fresh item,
 * without the queue, and hands triage only that issue's creation title and body.
 */

import type { QualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { issueAtCreation, viewIssue } from '../../.shared/issue.ts';
import { isRequestLabel } from '../../.shared/labels.ts';
import {
  bodyDigest,
  claimNext,
  decideIntake,
  enqueue,
  type IntakeRequest,
  newWorkItem,
  parseMode,
  parseOrder,
  parseTrustInput,
  readMaintainers,
  REQUEST_ACTIONS,
  type RequestAction,
  type TrustInput,
} from '../../.shared/workitem.ts';

/**
 * Decide the issue as a fresh item at creation: no stored document, no request, no
 * claim, and no labels or closed state that would give the answer away.
 */
function evaluate(
  subject: QualifiedPr,
  maintainers: ReadonlySet<string>,
  trustInput: TrustInput,
  at: string,
  runId: string
): void {
  const issue = viewIssue(subject);
  const created = issueAtCreation(subject, issue);
  const decision = decideIntake(
    newWorkItem(subject, at),
    { author: issue.author, labels: [], state: 'open', digest: bodyDigest(created.body) },
    maintainers,
    at,
    runId,
    trustInput
  );
  emit({
    path: decision.path,
    item: subject,
    target: `# ${created.title}\n\n${created.body}`,
    decision,
    seen: { title: created.title, body_digest: decision.body_digest, body_from: created.body_from },
  });
}

function main(): void {
  // The inputs' own validation: a value outside their vocabularies refuses the run
  // here, before anything is read or written.
  const mode = parseMode(text(process.env.INPUTS_MODE));
  const trustInput = parseTrustInput(text(process.env.INPUTS_TRUST));
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '')
    throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  const number = Number(trimmed(process.env.INPUTS_NUMBER));
  if (repo.host === '' || repo.path === '' || !Number.isInteger(number) || number <= 0) {
    throw new Error('repo_host, repo_path and a positive issue number are required');
  }
  const action = trimmed(process.env.INPUTS_ACTION) as RequestAction;
  if (!REQUEST_ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${REQUEST_ACTIONS.join(', ')}, not "${action}"`);
  }
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  // Read before any write, so a broken list refuses the run with nothing recorded.
  const maintainers = readMaintainers(repo);
  const at = new Date().toISOString();
  const subject = { repo, number };
  const label = trimmed(process.env.INPUTS_LABEL);
  if (mode === 'eval') {
    evaluate(subject, maintainers, trustInput, at, runId);
    return;
  }

  // Intake works issues. A pull request's event, or a label that asks for nothing,
  // records no request; the run still picks up whatever waits.
  const kind = trimmed(process.env.INPUTS_KIND);
  if (kind === 'issue' && (action !== 'added' || isRequestLabel(label))) {
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

  const doc = claimNext(order, at, runId);
  if (doc === null) {
    emit({ path: 'idle', item: null, target: '', decision: null, seen: null });
    return;
  }
  const issue = viewIssue(doc.subject);
  const decision = decideIntake(
    doc,
    { ...issue, digest: bodyDigest(issue.body) },
    maintainers,
    at,
    runId,
    trustInput
  );
  emit({ path: decision.path, item: doc.subject, target: issue.url, decision, seen: null });
}

try {
  main();
} catch (error) {
  refuse(`intake facts: ${error instanceof Error ? error.message : String(error)}`);
}
