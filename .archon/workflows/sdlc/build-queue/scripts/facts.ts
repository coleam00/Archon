/**
 * Claim the build queue's next item and write the issue the deciding agents read.
 *
 * Live claims the waiting item that sorts first with intake's claim and order, and
 * writes only that claim. A closed issue goes to `closed`, which apply parks without
 * an agent. Eval claims nothing and writes nothing outside the run's artifacts: it
 * reads the named issue's body at `as_of` and replays the rounds it was given.
 *
 * It also resolves the item's pull request as the forge reports it now. An open one
 * whose head is in the item's repository is the pull request the round continues;
 * otherwise the round opens one from a new branch named after the issue.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_PICKUP, type BuildRound, buildBranch, countedRounds, itemPullRequest } from '../../.shared/build.ts';
import { forgeSource, type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/forge.ts';
import { artifactsDir, emit, refuse, text, trimmed } from '../../.shared/io.ts';
import { issueBodyAt, viewIssue } from '../../.shared/issue.ts';
import { POLICY_DEFAULTS } from '../../.shared/policy-defaults.ts';
import { viewPr } from '../../.shared/pr.ts';
import { isObject } from '../../.shared/typed.ts';
import { claimNext, parseMode, parseOrder, readWorkItem, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

function positive(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** The `replay` input: recorded rounds, each with every field a live round stores. */
function parseReplay(value: string): BuildRound[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim() === '' ? '[]' : value);
  } catch {
    throw new Error('replay is not a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('replay is not a JSON array');
  return parsed.map((round, index) => {
    if (
      !isObject(round) ||
      typeof round.run_id !== 'string' ||
      typeof round.at !== 'string' ||
      typeof round.delivered !== 'boolean' ||
      typeof round.reason !== 'string' ||
      typeof round.pr_url !== 'string' ||
      typeof round.summary !== 'string' ||
      typeof round.artifacts !== 'string'
    ) {
      throw new Error(
        `replay[${String(index)}] is not {run_id, at, delivered, reason, pr_url, summary, artifacts}`
      );
    }
    return {
      run_id: round.run_id,
      at: round.at,
      delivered: round.delivered,
      reason: round.reason,
      pr_url: round.pr_url,
      summary: round.summary,
      artifacts: round.artifacts,
    };
  });
}

/** Write the issue every agent reads; its path is fixed so the prompts name it. */
function writeIssue(title: string, url: string, body: string, asOf: string): void {
  const dir = join(artifactsDir(), 'build');
  mkdirSync(dir, { recursive: true });
  const when = asOf === '' ? 'now' : `as it was at ${asOf}`;
  writeFileSync(join(dir, 'issue.md'), `# ${title}\n\n${url}, ${when}.\n\n${body}\n`);
}

/** For an open item, exactly one of `continues` and `branch` is set. */
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
  if (pr !== null && pr.state === 'open' && pr.head_repo !== null && sameRepo(pr.head_repo, subject.repo)) {
    return { pull_request: pr, continues: pr.number, branch: '' };
  }
  return { pull_request: pr, continues: null, branch: buildBranch(subject.number, title, runId) };
}

function emitItem(
  path: 'closed' | 'route' | 'answer',
  subject: QualifiedPr,
  url: string,
  doc: WorkItem | null,
  rounds: readonly BuildRound[],
  recorded: BuildRound | null,
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
    recorded,
    at_cap: atCap,
    policy_defaults: POLICY_DEFAULTS,
    ...itemPr,
  });
}

function main(): void {
  const mode = parseMode(text(process.env.INPUTS_MODE));
  const limit = positive('round_limit', trimmed(process.env.INPUTS_ROUND_LIMIT));
  const order = parseOrder(text(process.env.INPUTS_ORDER));
  const repo = {
    host: trimmed(process.env.INPUTS_REPO_HOST),
    path: trimmed(process.env.INPUTS_REPO_PATH),
  };
  if (repo.host === '' || repo.path === '') throw new Error('repo_host and repo_path are required');
  const runId = text(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  if (mode === 'eval') {
    const subject = { repo, number: positive('number', trimmed(process.env.INPUTS_NUMBER)) };
    const replay = parseReplay(text(process.env.INPUTS_REPLAY));
    const asOf = trimmed(process.env.INPUTS_AS_OF);
    const issue = viewIssue(subject);
    writeIssue(issue.title, issue.url, asOf === '' ? issue.body : issueBodyAt(subject, asOf), asOf);
    const doc = readWorkItem(subject.number);
    const recorded = replay.at(-1) ?? null;
    emitItem(
      recorded === null ? 'route' : 'answer',
      subject,
      issue.url,
      doc,
      replay.slice(0, -1),
      recorded,
      replay.length >= limit,
      resolvePr(subject, issue.title, doc, replay, runId)
    );
    return;
  }

  const doc = claimNext(order, new Date().toISOString(), runId, BUILD_PICKUP);
  if (doc === null) {
    emit({
      path: 'idle',
      item: null,
      url: '',
      record: null,
      brief: '',
      rounds: [],
      recorded: null,
      at_cap: false,
      policy_defaults: POLICY_DEFAULTS,
      ...NO_ITEM_PR,
    });
    return;
  }
  const issue = viewIssue(doc.subject);
  writeIssue(issue.title, issue.url, issue.body, '');
  const closed = issue.state === 'closed';
  const rounds = doc.facts.build?.rounds ?? [];
  emitItem(
    closed ? 'closed' : 'route',
    doc.subject,
    issue.url,
    doc,
    rounds,
    null,
    countedRounds(doc) + 1 >= limit,
    closed ? NO_ITEM_PR : resolvePr(doc.subject, issue.title, doc, rounds, runId)
  );
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
