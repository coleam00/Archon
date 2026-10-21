import { countedRounds } from '../../.shared/build.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { statePut } from '../../.shared/state.ts';
import { read, workItemName } from '../../.shared/workitem.ts';
import { emitItem, NO_ITEM_PR, positive, resolvePr, writeIssue } from '../../.shared/build-facts.ts';

function main(): void {
  const runId = text(process.env.WORKFLOW_ID);
  const pickup = trimmed(process.env.INPUTS_PICKUP_RUN);
  const branch = trimmed(process.env.INPUTS_SELECTED_BRANCH);
  if (runId === '' || pickup === '' || branch === '') throw new Error('run id, pickup_run and selected_branch are required');
  const number = positive('number', trimmed(process.env.INPUTS_NUMBER));
  const stored = read(workItemName(number));
  if (stored === undefined) throw new Error(`issue ${String(number)} has no work item`);
  const doc = stored.doc;
  if (doc.subject.repo.host !== trimmed(process.env.INPUTS_REPO_HOST) ||
    doc.subject.repo.path !== trimmed(process.env.INPUTS_REPO_PATH)) throw new Error('the selected item belongs to another repository');
  if (doc.claim?.run_id !== pickup && doc.claim?.run_id !== runId)
    throw new Error(`issue ${String(number)} is no longer claimed by pickup ${pickup}`);
  if (gitOrThrow('branch', '--show-current') !== branch)
    throw new Error(`the checkout is not on selected branch ${branch}; nothing was admitted`);
  const issue = viewIssue(doc.subject);
  const rounds = doc.facts.build?.rounds ?? [];
  const selected = resolvePr(doc.subject, issue.title, doc, rounds, pickup);
  if (issue.state !== 'closed' && selected.branch !== branch)
    throw new Error(`the item's branch changed from ${branch} to ${selected.branch}; nothing was admitted`);
  const admitted = {
    ...doc,
    claim: { ...doc.claim, run_id: runId },
    links: { runs: [...doc.links.runs.filter(id => id !== runId), runId].slice(-50) },
  };
  if (doc.claim.run_id !== runId && statePut(stored.name, admitted, stored.revision) !== 'ok')
    throw new Error(`issue ${String(number)} changed during admission; resume this worker to retry`);
  writeIssue(issue.title, issue.url, issue.body);
  emitItem(issue.state === 'closed' ? 'closed' : 'route', doc.subject, issue.url, admitted, rounds,
    countedRounds(doc) + 1 >= positive('round_limit', trimmed(process.env.INPUTS_ROUND_LIMIT)),
    issue.state === 'closed' ? NO_ITEM_PR : selected, []);
}

try {
  main();
} catch (error) {
  refuse(`build-round admission: ${error instanceof Error ? error.message : String(error)}`);
}
