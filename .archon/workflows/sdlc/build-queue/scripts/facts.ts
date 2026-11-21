/**
 * Read the issue the run builds and write the text the deciding agents read.
 *
 * The run is on the issue's item (`--item issue-<number>`), and the engine admits one
 * build run per item, so no claim is taken: a run that reaches here is the only one
 * building the issue. It refuses a run on another item or none, an issue intake has not
 * recorded, and one that does not wait for a round, with the reason. A closed issue goes
 * to `closed`, which apply parks without an agent.
 *
 * It also resolves the item's pull request as the forge reports it now. An open one
 * whose head is in the item's repository is the candidate the round continues;
 * otherwise the round opens one from a new branch named after the issue.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BuildRound, buildBranch, countedRounds, itemPullRequest, waitingItem } from '../../.shared/build.ts';
import { artifactsDir, emit, input, item as runItem, refuse, runId as workflowRunId } from 'archon:script';
import { type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/identity.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { viewPr } from '../../.shared/pr.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import { itemKey, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * The engine's one-run-per-item rule is what keeps two runs off one issue, and it holds
 * only for a run on that issue's item.
 */
function requireOwnItem(number: number): void {
  const key = itemKey(number);
  const on = runItem()?.item.key;
  if (on !== key) {
    throw new Error(`the run is on ${on === undefined ? 'no item' : `item ${on}`}; start issue ${String(number)} with --item ${key}`);
  }
}

/**
 * The project's `work/<number>` can belong to another repository than the run's, as in a
 * checkout whose `origin` is a fork.
 */
function requireRunRepo(doc: WorkItem): void {
  const repo = workflowRepo();
  if (!sameRepo(doc.subject.repo, repo)) {
    throw new Error(
      `issue ${String(doc.subject.number)}'s work item is ${doc.subject.repo.host}/${doc.subject.repo.path}'s, not ${repo.host}/${repo.path}'s`
    );
  }
}

/** Write the issue every agent reads; its path is fixed so the prompts name it. */
function writeIssue(title: string, url: string, body: string): void {
  const dir = join(artifactsDir(), 'build');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'issue.md'), `# ${title}\n\n${url}, now.\n\n${body}\n`);
}

/**
 * `continues` is the candidate: the open same-repository pull request a round may
 * continue. Whether it does is the route agent's call, since a dated ruling can
 * supersede it, so `branch` is always set for a round that continues none.
 */
interface ItemPr {
  readonly pull_request: PrRecord | null;
  readonly continues: number | null;
  readonly branch: string;
}

const NO_ITEM_PR: ItemPr = { pull_request: null, continues: null, branch: '' };

function resolvePr(subject: QualifiedPr, title: string, doc: WorkItem, rounds: readonly BuildRound[]): ItemPr {
  const ref = itemPullRequest(rounds, doc.facts.triage, subject.repo);
  const pr = ref === null ? null : viewPr(ref).pr;
  const branch = buildBranch(subject.number, title, workflowRunId());
  if (pr !== null && pr.state === 'open' && pr.head_repo !== null && sameRepo(pr.head_repo, subject.repo)) {
    return { pull_request: pr, continues: pr.number, branch };
  }
  return { pull_request: pr, continues: null, branch };
}

function main(): void {
  const limit = positive('round_limit', input('round_limit').trim());
  const number = positive('number', input('number').trim());
  requireOwnItem(number);
  const at = new Date().toISOString();
  const doc = waitingItem(number);
  requireRunRepo(doc);
  const issue = viewIssue(doc.subject);
  writeIssue(issue.title, issue.url, issue.body);
  const closed = issue.state === 'closed';
  const rounds = doc.facts.build?.rounds ?? [];
  emit({
    path: closed ? 'closed' : 'route',
    item: doc.subject,
    url: issue.url,
    read_at: at,
    record: withPlainReports(doc),
    brief: doc.facts.build?.brief ?? '',
    rounds,
    at_cap: countedRounds(doc) + 1 >= limit,
    related: doc.facts.triage?.related ?? [],
    ...(closed ? NO_ITEM_PR : resolvePr(doc.subject, issue.title, doc, rounds)),
  });
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
