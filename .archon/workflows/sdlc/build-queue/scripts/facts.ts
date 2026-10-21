import { BUILD_PICKUP, claimNamed, dueBlocked, countedRounds } from '../../.shared/build.ts';
import { emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { stateDocuments } from '../../.shared/state.ts';
import { claimNext, parseOrder, read } from '../../.shared/workitem.ts';
import { positive, emitItem, resolvePr, NO_ITEM_PR } from '../../.shared/build-facts.ts';

function main(): void {
  const limit = positive('round_limit', trimmed(process.env.INPUTS_ROUND_LIMIT));
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  const number = trimmed(process.env.INPUTS_NUMBER);
  const revisits = number === '' && trimmed(process.env.INPUTS_RETRIAGE_AS) !== '';
  const blocked = revisits ? dueBlocked(new Date().toISOString()) : [];
  const owned = stateDocuments('work/').map(row => read(row.name, row))
    .find(row => row?.doc.claim?.run_id === runId)?.doc;
  const doc = owned ?? (
    number === ''
      ? claimNext(order, new Date().toISOString(), runId, BUILD_PICKUP)
      : claimNamed(positive('number', number), new Date().toISOString(), runId));
  if (doc === null) {
    emit({
      path: 'idle',
      item: null,
      url: '',
      record: null,
      brief: '',
      rounds: [],
      at_cap: false,
      policy_defaults: POLICY_DEFAULTS,
      ...NO_ITEM_PR,
      blocked,
      blocked_count: blocked.length,
    });
    return;
  }
  const issue = viewIssue(doc.subject);
  const closed = issue.state === 'closed';
  const rounds = doc.facts.build?.rounds ?? [];
  emitItem(
    closed ? 'closed' : 'route',
    doc.subject,
    issue.url,
    doc,
    rounds,
    countedRounds(doc) + 1 >= limit,
    closed ? NO_ITEM_PR : resolvePr(doc.subject, issue.title, doc, rounds, runId),
    blocked
  );
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
