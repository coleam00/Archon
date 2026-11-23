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
 *
 * A run the `build-after-answer` binding started carries the answer to the ask an
 * earlier run left on the item (INPUTS_DECISIONS) and what that run asked (INPUTS_ASKED).
 * The answer is applied first, so the agents read it: the chosen option's ruling and the
 * maintainer's words go into the issue body as one dated "Current scope" section, and the
 * answer is recorded on the work item. A `continue` then runs its round in this run; a
 * `ready` or `park` ends it on the `answered` path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AskedBy,
  type BuildEffect,
  type BuildRound,
  buildBranch,
  countedRounds,
  itemPullRequest,
  waitingItem,
  withBuild,
} from '../../.shared/build.ts';
import { artifactsDir, emit, input, item as runItem, refuse, runId as workflowRunId } from 'archon:script';
import { type PrRecord, type QualifiedPr, sameRepo } from '../../.shared/identity.ts';
import { nullableJson } from '../../.shared/inputs.ts';
import { appendSection, viewIssue } from '../../.shared/issue.ts';
import { viewPr } from '../../.shared/pr.ts';
import { rulingHeading } from '../../.shared/queue.ts';
import { workflowRepo } from '../../.shared/remote.ts';
import { itemKey, readWorkItem, updateWorkItem, type WorkItem, withPlainReports } from '../../.shared/workitem.ts';

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

/** One settled ask, as the asks-settled binding's `{ answers: true }` passes it. */
interface SettledAsk {
  readonly closedAs: 'answered' | 'withdrawn';
  readonly answer: { readonly text: string } | null;
  readonly option: { readonly id: string; readonly does: string } | null;
}

/** What the asking run's apply recorded as `asked` in its result. */
interface Asked {
  readonly brief: string;
  readonly by: AskedBy;
  readonly options: readonly { readonly id: string; readonly effect: BuildEffect; readonly ruling: string }[];
}

const STATUS = { continue: 'next', ready: 'ready', park: 'parked' } as const;

const ABOUT: Record<AskedBy, string> = {
  route: "the build queue's routing question",
  stop: "the build queue's question on a stopped run",
  scope: "the build queue's scope question",
};

/**
 * Apply the answer this run was started with, or return null when it was started
 * without one. The effect is read from the chosen option's id, never from the answer's
 * text. `other`, the option every ask offers, means: continue, with the text as the ruling.
 */
function applyAnswer(number: number, at: string): { readonly effect: BuildEffect; readonly doc: WorkItem } | null {
  const settled = nullableJson(input('decisions')) as readonly SettledAsk[] | null;
  if (settled === null) return null;
  const asked = nullableJson(input('asked')) as Asked | null;
  const answered = settled.find(entry => entry.closedAs === 'answered');
  if (answered?.option == null || asked === null) throw new Error('the run was started with no answered option or no asking result');
  const doc = readWorkItem(number);
  if (doc?.facts.build?.status !== 'asking') throw new Error(`issue ${String(number)} is not asking: its answer is not applied`);
  const id = answered.option.id;
  const option = id === 'other' ? { id, effect: 'continue' as const, ruling: '' } : asked.options.find(candidate => candidate.id === id);
  if (option === undefined) throw new Error(`the answer chose "${id}", which the asking run did not offer`);
  const item = doc.subject;
  if (option.effect === 'ready' && itemPullRequest(doc.facts.build.rounds, doc.facts.triage, item.repo) === null) {
    throw new Error(`the ready choice "${id}" hands nothing to the merge queue: issue ${String(number)} has no pull request`);
  }
  const words = answered.answer?.text.trim() ?? '';
  const ruling = [option.ruling.trim(), words === '' ? '' : `The maintainer's words: ${words}`].filter(part => part !== '').join('\n\n');
  const heading = ruling === '' ? '' : rulingHeading(at, ABOUT[asked.by]);
  if (ruling !== '') appendSection(item, heading, ruling);
  const section = heading === '' ? '' : ` The ruling is the issue body's "${heading}" section, which is part of the contract.`;
  const does = answered.option.does;
  const written = updateWorkItem(item, current =>
    withBuild(current, {
      at,
      run_id: workflowRunId(),
      round: null,
      entry: { at, run_id: workflowRunId(), decision: `answered: ${option.effect}`, reason: does, links: [], answer: { choice: id, text: words, at } },
      status: STATUS[option.effect],
      brief: option.effect === 'continue' ? `${asked.brief}\n\nThe maintainer chose "${id}": ${does}${section}` : '',
    })
  );
  return { effect: option.effect, doc: written };
}

function main(): void {
  const limit = positive('round_limit', input('round_limit').trim());
  const number = positive('number', input('number').trim());
  requireOwnItem(number);
  const at = new Date().toISOString();
  const answered = applyAnswer(number, at);
  if (answered !== null && answered.effect !== 'continue') {
    const { effect, doc } = answered;
    const next = effect === 'ready' ? 'its pull request waits for the merge queue' : 'the queue stops working it until a re-triage';
    emit({
      path: 'answered',
      item: doc.subject,
      url: '',
      read_at: at,
      record: withPlainReports(doc),
      brief: '',
      rounds: [],
      at_cap: false,
      related: [],
      ...NO_ITEM_PR,
      answered: { decision: STATUS[effect], summary: `Issue ${String(number)}: the maintainer chose ${effect}; ${next}.` },
    });
    return;
  }
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
    answered: null,
  });
}

try {
  main();
} catch (error) {
  refuse(`build-queue facts: ${error instanceof Error ? error.message : String(error)}`);
}
