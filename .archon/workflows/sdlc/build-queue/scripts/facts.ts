/**
 * Claim the build queue's next item and write the issue the deciding agents read.
 *
 * It claims the waiting item that sorts first in intake's order, or the item the
 * `number` input names, or the one the run's message resolved to, and writes only the
 * round's branch on it. A message interpret resolved to nothing refuses the run with its
 * reason; one it resolved to a work order or to new work claims nothing and goes to
 * `order` or `handoff`. With `orders_only` on it
 * first marks done each open work order whose members all finished. A named item that cannot
 * be claimed refuses the run with the reason. A closed issue goes to `closed`, which
 * apply parks without an agent.
 *
 * It also resolves the item's pull request as the forge reports it now. An open one
 * whose head is in the item's repository is the candidate the round continues;
 * otherwise the round opens one from a new branch named after the issue, which it
 * records on the item. A pull request an earlier run opened and never recorded becomes
 * that run's round first.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_PICKUP,
  type BuildRound,
  buildBranch,
  countedRounds,
  itemPullRequest,
  withUnrecordedRound,
} from '../../.shared/build.ts';
import { type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, nullableJson, refuse, trimmed, workflowRunId } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { openOrderMembers } from '../../.shared/order.ts';
import { viewPr } from '../../.shared/pr.ts';
import {
  claimNamed,
  claimNext,
  type Pickup,
  readWorkItem,
  updateHeld,
  type WorkItem,
  withPlainReports,
} from '../../.shared/workitem.ts';

function positive(name: string, value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** What interpret declared about the run's message; null when the run had none. */
interface Interpreted {
  readonly decision: 'build' | 'choose' | 'order' | 'intake' | 'none';
  readonly number: number | null;
  readonly reason: string;
}

/**
 * The item the run names: the `number` input, else the item interpret resolved the
 * message to, or the one the person picked from its options. Null names none, so the
 * run picks up the waiting item that sorts first; `order` and `handoff` claim nothing.
 */
function namedItem(): number | null | 'order' | 'handoff' {
  const number = trimmed(process.env.INPUTS_NUMBER);
  if (number !== '') return positive('number', number);
  const interpreted = nullableJson(process.env.INPUTS_INTERPRETED) as Interpreted | null;
  if (interpreted === null) return null;
  switch (interpreted.decision) {
    case 'build':
      return positive("interpret's number", interpreted.number);
    case 'choose': {
      const picked = nullableJson(process.env.INPUTS_PICKED) as { number?: unknown } | null;
      return positive('the picked issue number', picked?.number);
    }
    case 'order':
      return 'order';
    case 'intake':
      return 'handoff';
    case 'none':
      throw new Error(`the message names nothing to build: ${interpreted.reason}`);
  }
}

/**
 * A named number is an issue of the run's repository, and the project's `work/<number>`
 * can belong to another, as in a checkout whose `origin` is a fork. Refuses before the
 * claim, so a claim never touches that other repository's item.
 */
function requireRunRepo(number: number): void {
  const repo = nullableJson(process.env.INPUTS_REPO) as QualifiedPr['repo'];
  const subject = readWorkItem(number)?.subject;
  if (subject !== undefined && !sameRepo(subject.repo, repo)) {
    throw new Error(
      `issue ${String(number)}'s work item is ${subject.repo.host}/${subject.repo.path}'s, not ${repo.host}/${repo.path}'s`
    );
  }
}

const NOTHING = { item: null, url: '', record: null, brief: '', rounds: [], at_cap: false, related: [] };

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

function resolvePr(
  subject: QualifiedPr,
  branch: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[]
): ItemPr {
  const ref = itemPullRequest(rounds, doc?.facts.triage, subject.repo);
  const pr = ref === null ? null : viewPr(ref).pr;
  if (pr !== null && pr.state === 'open' && pr.head_repo !== null && sameRepo(pr.head_repo, subject.repo)) {
    return { pull_request: pr, continues: pr.number, branch };
  }
  return { pull_request: pr, continues: null, branch };
}

function emitItem(
  path: 'closed' | 'route',
  subject: QualifiedPr,
  url: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  atCap: boolean,
  itemPr: ItemPr
): void {
  emit({
    path,
    item: subject,
    url,
    record: doc === null ? null : withPlainReports(doc),
    brief: doc?.facts.build?.brief ?? '',
    rounds,
    at_cap: atCap,
    related: doc?.facts.triage?.related ?? [],
    ...itemPr,
  });
}

/**
 * With `orders_only` on, an item waits only while it is a member of an open work order,
 * so no open order claims nothing. A named item is claimed either way.
 */
function pickup(): Pickup {
  if (trimmed(process.env.INPUTS_ORDERS_ONLY) !== 'true') return BUILD_PICKUP;
  const members = openOrderMembers(new Date().toISOString());
  return { ...BUILD_PICKUP, waits: doc => members.has(doc.subject.number) && BUILD_PICKUP.waits(doc) };
}

function main(): void {
  const limit = positive('round_limit', trimmed(process.env.INPUTS_ROUND_LIMIT));
  const runId = workflowRunId();

  const named = namedItem();
  if (named === 'order' || named === 'handoff') {
    emit({ path: named, ...NOTHING, ...NO_ITEM_PR });
    return;
  }
  if (named !== null) requireRunRepo(named);
  const claimed = named === null ? claimNext(pickup()) : claimNamed(named, BUILD_PICKUP);
  if (claimed === null) {
    emit({ path: 'idle', ...NOTHING, ...NO_ITEM_PR });
    return;
  }
  const issue = viewIssue(claimed.subject);
  writeIssue(issue.title, issue.url, issue.body);
  if (issue.state === 'closed') {
    emitItem('closed', claimed.subject, issue.url, claimed, claimed.facts.build?.rounds ?? [], countedRounds(claimed) + 1 >= limit, NO_ITEM_PR);
    return;
  }
  // The branch is stored, not derived later: the title can change before the next round reads it.
  const branch = buildBranch(claimed.subject.number, issue.title, runId);
  const doc = updateHeld(claimed.subject, held => ({
    ...withUnrecordedRound(held, runId, new Date().toISOString()),
    opening: { run_id: runId, branch },
  }));
  const rounds = doc.facts.build?.rounds ?? [];
  const itemPr = resolvePr(doc.subject, branch, doc, rounds);
  emitItem('route', doc.subject, issue.url, doc, rounds, countedRounds(doc) + 1 >= limit, itemPr);
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
