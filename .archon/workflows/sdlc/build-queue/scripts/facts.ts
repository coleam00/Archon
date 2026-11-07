/**
 * Claim the build queue's next item and write the issue the deciding agents read.
 *
 * It claims the waiting item that sorts first with intake's claim and order, or the
 * item the `number` input names, and writes only that claim. With `orders_only` on it
 * first marks done each open work order whose members all finished. A named item that cannot
 * be claimed refuses the run with the reason. A closed issue goes to `closed`, which
 * apply parks without an agent.
 *
 * It also resolves the item's pull request as the forge reports it now. An open one
 * whose head is in the item's repository is the candidate the round continues;
 * otherwise the round opens one from a new branch named after the issue, which it
 * records on the claim.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_PICKUP,
  type BuildRound,
  buildBranch,
  countedRounds,
  itemPullRequest,
} from '../../.shared/build.ts';
import { type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { viewIssue } from '../../.shared/issue.ts';
import { openOrderMembers } from '../../.shared/order.ts';
import { viewPr } from '../../.shared/pr.ts';
import { claimNamed, claimNext, type Pickup, updateClaimed, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
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

function resolvePr(
  subject: QualifiedPr,
  title: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  runId: string
): ItemPr {
  const ref = itemPullRequest(rounds, doc?.facts.triage, subject.repo);
  const pr = ref === null ? null : viewPr(ref).pr;
  const branch = buildBranch(subject.number, title, runId);
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
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  const number = trimmed(process.env.INPUTS_NUMBER);
  const doc =
    number === ''
      ? claimNext(new Date().toISOString(), runId, pickup())
      : claimNamed(positive('number', number), new Date().toISOString(), runId, BUILD_PICKUP);
  if (doc === null) {
    emit({
      path: 'idle',
      item: null,
      url: '',
      record: null,
      brief: '',
      rounds: [],
      at_cap: false,
      ...NO_ITEM_PR,
    });
    return;
  }
  const issue = viewIssue(doc.subject);
  writeIssue(issue.title, issue.url, issue.body);
  const closed = issue.state === 'closed';
  const rounds = doc.facts.build?.rounds ?? [];
  const itemPr = closed ? NO_ITEM_PR : resolvePr(doc.subject, issue.title, doc, rounds, runId);
  // A release reads the branch from the claim: the title can change before then.
  const recorded = closed
    ? doc
    : updateClaimed(doc.subject, runId, held => ({
        ...held,
        claim: held.claim && { ...held.claim, branch: itemPr.branch },
      }));
  emitItem(closed ? 'closed' : 'route', doc.subject, issue.url, recorded, rounds, countedRounds(doc) + 1 >= limit, itemPr);
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
