/**
 * Claim the build queue's next item and write the issue the deciding agents read.
 *
 * It claims the waiting item that sorts first with intake's claim and order, or the
 * item the `number` input names, and writes only that claim. A named item that cannot
 * be claimed refuses the run with the reason. A closed issue goes to `closed`, which
 * apply parks without an agent.
 *
 * It also resolves the item's pull request as the forge reports it now. An open one
 * whose head is in the item's repository is the candidate the round continues;
 * otherwise the round opens one from a new branch named after the issue.
 *
 * Before claiming, it wakes the items a `wait` answer parked whose blockers the forge
 * now reports all closed or merged, back to `next`. A woken item this run does not
 * claim gets a build-queue run of its own at once, as a continue does. `wake` reports
 * them, and each item a blocker it could not read keeps parked.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_PICKUP,
  type BuildRound,
  buildBranch,
  claimNamed,
  countedRounds,
  itemPullRequest,
  type BlockerState,
  wakeSettled,
} from '../../.shared/build.ts';
import { forgeSource, type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, note, refuse, text, trimmed } from '../../.shared/io.ts';
import { NotAnIssueError, viewIssue } from '../../.shared/issue.ts';
import { type BuildQueueSelections, launchNextRound } from '../../.shared/launch.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { viewPr } from '../../.shared/pr.ts';
import { claimNext, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

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
  const pr = ref === null ? null : viewPr(ref, forgeSource()).pr;
  const branch = buildBranch(subject.number, title, runId);
  if (pr !== null && pr.state === 'open' && pr.head_repo !== null && sameRepo(pr.head_repo, subject.repo)) {
    return { pull_request: pr, continues: pr.number, branch };
  }
  return { pull_request: pr, continues: null, branch };
}

function issueOrPrState(ref: QualifiedPr): 'open' | 'closed' | 'merged' {
  try {
    return viewIssue(ref).state;
  } catch (error) {
    if (error instanceof NotAnIssueError) return viewPr(ref, forgeSource()).pr.state;
    throw error;
  }
}

function blockerState(ref: QualifiedPr): BlockerState {
  try {
    return issueOrPrState(ref);
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/** Launch each woken item this run did not claim; one summary line per woken or still-parked item. */
function wakeLines(settled: { woken: number[]; unreadable: string[] }, claimed: QualifiedPr | null, repo: QualifiedPr['repo'], runId: string): string {
  const selections: BuildQueueSelections = { retriage_as: text(process.env.INPUTS_RETRIAGE_AS), round_limit: text(process.env.INPUTS_ROUND_LIMIT) };
  const woken = settled.woken.map(number =>
    number === claimed?.number
      ? `issue ${String(number)}: its blockers settled, and this run builds it`
      : `issue ${String(number)}: its blockers settled; ${launchNextRound({ repo, number }, runId, selections)}`
  );
  return [...woken, ...settled.unreadable].join('\n');
}

function emitItem(
  path: 'closed' | 'route',
  subject: QualifiedPr,
  url: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  atCap: boolean,
  itemPr: ItemPr,
  wake: string
): void {
  emit({
    wake,
    path,
    item: subject,
    url,
    record: doc === null ? null : withPlainReports(doc),
    brief: doc?.facts.build?.brief ?? '',
    rounds,
    at_cap: atCap,
    policy_defaults: POLICY_DEFAULTS,
    ...itemPr,
  });
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
  const settled = wakeSettled(new Date().toISOString(), runId, repo, blockerState);
  let doc: WorkItem | null;
  try {
    doc =
      number === ''
        ? claimNext(new Date().toISOString(), runId, BUILD_PICKUP)
        : claimNamed(positive('number', number), new Date().toISOString(), runId);
  } catch (error) {
    // The items this run already woke still get their own runs; the refusal stands.
    const lines = wakeLines(settled, null, repo, runId);
    if (lines !== '') note(lines);
    throw error;
  }
  const wake = wakeLines(settled, doc?.subject ?? null, repo, runId);
  if (doc === null) {
    emit({
      wake,
      path: 'idle',
      item: null,
      url: '',
      record: null,
      brief: '',
      rounds: [],
      at_cap: false,
      policy_defaults: POLICY_DEFAULTS,
      ...NO_ITEM_PR,
    });
    return;
  }
  const issue = viewIssue(doc.subject);
  writeIssue(issue.title, issue.url, issue.body);
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
    wake
  );
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
