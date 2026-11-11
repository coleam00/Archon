/**
 * The build queue's record on an item's work item: `facts.build`.
 *
 * It is the queue's memory of the item: every round it ran (one build-queue run), every
 * decision it made with the person's answer when it asked, and what happens next. The
 * deciding agents read it before deciding, and the queue's pickup reads `status` to
 * know whether the item waits for it.
 */

import { type QualifiedPr, sameRepo } from './forge.ts';
import { followUp } from './follow-up.ts';
import { note, text } from './io.ts';
import type { NodeOutput } from './outputs.generated.ts';
import { findPrByHead, PR_CREATE_UNRESOLVED, prFromUrl } from './pr.ts';
import { type Attention, clipped, type DecisionEntry, withDecision } from './queue.ts';
import { stateDocuments, statePut } from './state.ts';
import {
  type HistoryEntry,
  newest,
  type Pickup,
  read,
  type Stage,
  type TriageFacts,
  type WorkItem,
} from './workitem.ts';

/**
 * What a build choice does when a person picks it; archon-build-queue.yaml declares the
 * same enum. `continue` launches the next round from the brief. `ready` hands the pull
 * request to the merge queue as it stands, such as after a maintainer finished it by
 * hand. `park` stops work until a re-triage.
 */
export const BUILD_EFFECTS = ['continue', 'ready', 'park'] as const;
export type BuildEffect = (typeof BUILD_EFFECTS)[number];
export type BuildAttention = Attention<BuildEffect>;

/** Which decision raised an attention item: its class label, which the YAML also declares. */
export type AskedBy = 'route' | 'stop' | 'scope';

/** The stages a triaged item can be launched from: a READY verdict's routes. */
export const LAUNCH_STAGES = [
  'investigate',
  'plan',
  'deliver',
  'continue',
] as const satisfies readonly Stage[];

/** One review verdict a round's delivery published, at the time the engine produced it. */
export interface ReviewVerdict {
  readonly ready: boolean;
  readonly at: string;
}

/**
 * A full validation the delivery's CI agent ran itself, at the commit it ran on, as its
 * typed `ci-report` declared it. Under the pack's `ci: none` setting the merge gate
 * trusts this instead of forge checks.
 */
export type Validation = NonNullable<NodeOutput<'archon-deliver', 'ci'>['validation']>;

/**
 * One build round, as its terminal report ended it. `run_id` is the build-queue run that
 * delivered it; the ship work runs inside that run through `include:`.
 */
export interface BuildRound {
  readonly run_id: string;
  readonly at: string;
  readonly delivered: boolean;
  readonly reason: string;
  readonly pr_url: string;
  /**
   * That pull request's number in the item's repository, as the forge resolved the URL
   * when the round was recorded. Absent on a round recorded before rounds carried it,
   * whose URL the forge resolves when the item's pull request is read.
   */
  readonly pr_number?: number;
  readonly summary: string;
  readonly artifacts: string;
  /**
   * The route the round took, as the queue's route agent declared it; its
   * `output_format` owns the vocabulary. Absent on a round recorded before rounds
   * carried it, or recorded at a release.
   */
  readonly route?: string;
  /**
   * Every review verdict the round's delivery published, oldest first. Absent on a round
   * recorded before rounds carried them, recorded at a release, or whose run's typed
   * outputs could not be read.
   */
  readonly reviews?: readonly ReviewVerdict[];
  /** The latest validation the round's delivery ran; absent when it ran none. */
  readonly validation?: Validation;
}

/**
 * Who owns the item, as the build queue last recorded it. `next`: the build queue, for
 * its next launch from `brief`. `asking`: the build queue, paused on the item's
 * attention item. `ready`: handed to the merge queue, which owns its pull request from
 * here. `parked`: no queue, until a re-triage.
 */
export type BuildStatus = 'next' | 'asking' | 'ready' | 'parked';

export interface BuildRecord {
  readonly status: BuildStatus;
  /** What the next launch starts from; empty unless the status is `next`. */
  readonly brief: string;
  readonly rounds: readonly BuildRound[];
  readonly decisions: readonly DecisionEntry[];
  /** When the queue last decided the item. */
  readonly at: string;
}

// Rounds, decisions and their prose are capped so the record keeps the work item well
// under the state store's 64 KiB limit. `archon state log` keeps every revision.
export const KEPT_ROUNDS = 10;
/** Whether the item waits for the build queue. */
export function buildWaits(doc: WorkItem): boolean {
  if (!(LAUNCH_STAGES as readonly string[]).includes(doc.stage)) return false;
  const build = doc.facts.build;
  if (build === undefined || build.status === 'next') return true;
  // A re-triage after the queue's last decision starts the item over.
  return (doc.facts.triage?.at ?? '') > build.at;
}

export const BUILD_PICKUP: Pickup = { stage: 'build', waits: buildWaits };

/** A blocked item for the revisit agent: which issue, and intake's summary of why it is blocked. */
export interface BlockedItem {
  readonly number: number;
  readonly summary: string;
}

// A scheduled queue would otherwise judge the same blocked items on every run.
const REVISIT_EVERY_MS = 6 * 60 * 60 * 1000;
const REVISITED = 'revisited';

/**
 * The blocked items no live run holds and no run has revisited in the last few hours,
 * each recorded as revisited by this run before it is listed. The record is a
 * conditional write at the revision read, so of several runs that list at once exactly
 * one gets each item; a run whose write loses leaves the item to the run that won.
 */
export function dueBlocked(at: string, runId: string): BlockedItem[] {
  const due = new Date(Date.parse(at) - REVISIT_EVERY_MS).toISOString();
  const items: BlockedItem[] = [];
  for (const stored of stateDocuments('work/')) {
    const item = read(stored.name, stored);
    if (item === undefined) continue;
    const { doc } = item;
    const last = doc.history.filter(entry => entry.outcome === REVISITED).at(-1)?.at ?? '';
    if (doc.stage !== 'blocked' || item.lease?.live || last >= due) continue;
    const entry: HistoryEntry = { at, stage: 'build', run_id: runId, outcome: REVISITED, summary: 'listed for the revisit agent' };
    if (statePut(item.name, { ...doc, history: newest([...doc.history, entry]) }, item.revision) !== 'ok') {
      note(`revisit leaves ${item.name} to the run that changed it`);
      continue;
    }
    const triaged = doc.history.filter(entry => entry.outcome === 'blocked').at(-1);
    items.push({ number: doc.subject.number, summary: triaged?.summary ?? '' });
  }
  return items;
}

/**
 * The rounds that count toward the round cap: those since the item's scope last
 * changed, by a re-triage or a person's answer.
 */
export function countedRounds(doc: WorkItem): number {
  const build = doc.facts.build;
  if (build === undefined) return 0;
  const answered = build.decisions.filter(entry => entry.answer !== undefined).at(-1)?.at ?? '';
  const triaged = doc.facts.triage?.at ?? '';
  const since = answered > triaged ? answered : triaged;
  return build.rounds.filter(round => round.at > since).length;
}

/** The latest validation any of the item's build rounds recorded, or null. */
export function latestValidation(doc: WorkItem): Validation | null {
  return doc.facts.build?.rounds.filter(round => round.validation !== undefined).at(-1)?.validation ?? null;
}

/**
 * The item's pull request: the latest round's that opened one, else the one triage
 * routed the item to continue. A stored URL that is not a pull request of the item's
 * repository is refused, not guessed around.
 */
export function itemPullRequest(
  rounds: readonly BuildRound[],
  triage: TriageFacts | undefined,
  repo: QualifiedPr['repo']
): QualifiedPr | null {
  const triaged = triage?.pull_request == null ? null : { repo, number: triage.pull_request };
  const unresolved = rounds.map(round => round.reason).lastIndexOf(PR_CREATE_UNRESOLVED);
  const settled = rounds.slice(unresolved + 1).some(round => round.pr_url !== '');
  if (unresolved >= 0 && !settled) {
    const round = rounds[unresolved];
    // Only a re-triage after the unresolved round has looked for the PR it may have opened.
    if (triage !== undefined && triage.at > (round?.at ?? '')) return triaged;
    throw new Error(`round ${round?.run_id} has an unresolved PR create; reconcile its artifacts and re-triage the item, naming the PR if one exists`);
  }
  const last = rounds.filter(round => round.pr_url !== '').at(-1);
  if (last === undefined) return triaged;
  return { repo, number: last.pr_number ?? roundPrNumber(last.pr_url, repo) };
}

/** The number of the round's pull request, which must be one of the item's repository. */
export function roundPrNumber(url: string, repo: QualifiedPr['repo']): number {
  const pr = prFromUrl(url);
  if (!sameRepo(pr.repo, repo)) {
    throw new Error(`round pr_url ${url} is not a pull request of ${repo.host}/${repo.path}`);
  }
  return pr.number;
}

/** Every round's branch starts with this, so a pull request from such a branch is the build queue's. */
export const BUILD_BRANCH_PREFIX = 'build/';

/**
 * The branch a round with no pull request to continue opens one from. The run-id
 * suffix keeps a name from being reused: after a closed pull request or a failed
 * create, the non-forcing push onto the old branch would refuse every round.
 */
export function buildBranch(number: number, title: string, runId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return [BUILD_BRANCH_PREFIX + String(number), slug, runId.slice(0, 8)].filter(part => part !== '').join('-');
}

export interface BuildChange {
  readonly at: string;
  readonly run_id: string;
  readonly round: BuildRound | null;
  readonly entry: DecisionEntry;
  readonly status: BuildStatus;
  readonly brief: string;
}

/** The work item with one decision recorded on it. */
export function withBuild(doc: WorkItem, change: BuildChange): WorkItem {
  const prior = doc.facts.build;
  const round = change.round === null ? [] : [{ ...change.round, summary: clipped(change.round.summary) }];
  const build: BuildRecord = {
    status: change.status,
    brief: change.status === 'next' ? change.brief : '',
    rounds: [...(prior?.rounds ?? []), ...round].slice(-KEPT_ROUNDS),
    decisions: withDecision(prior?.decisions, change.entry),
    at: change.at,
  };
  return {
    ...doc,
    facts: { ...doc.facts, build },
    links: { runs: [...doc.links.runs.filter(id => id !== change.run_id), change.run_id].slice(-50) },
  };
}

/** The reason of a round recorded for a run that ended before it decided the round. */
export const ENDED_UNDECIDED = 'ended_undecided';

/**
 * Start the item's next build-queue round now, through the operator's build-queue
 * binding (`build_queue_binding`). One run starts at most one next round per item.
 */
export function nextRound(item: QualifiedPr, runId: string): string {
  const { host, path } = item.repo;
  return followUp(
    text(process.env.INPUTS_BUILD_QUEUE_BINDING),
    `build-round:${host}/${path}#${String(item.number)}:${runId}`,
    { repo_host: host, repo_path: path, number: String(item.number) },
    'its next round'
  );
}

/**
 * The work item, held by the round of `runId`, with the round an earlier run left
 * unrecorded: the pull request whose head is the branch that run recorded in `opening`.
 * A run that opened none, and a run that recorded its round before it stopped, such as
 * one that asked, add nothing.
 */
export function withUnrecordedRound(doc: WorkItem, runId: string, at: string): WorkItem {
  const prior = doc.facts.build;
  const left = doc.opening;
  if (left === undefined || left.run_id === runId || prior?.rounds.some(round => round.run_id === left.run_id)) return doc;
  const pr = findPrByHead(doc.subject.repo, left.branch);
  if (pr === undefined) return doc;
  const round: BuildRound = {
    run_id: left.run_id,
    at,
    delivered: false,
    reason: ENDED_UNDECIDED,
    pr_url: pr.url,
    pr_number: pr.number,
    summary: `The run ended after it opened ${pr.url} and before it recorded the round.`,
    artifacts: '',
  };
  const build: BuildRecord = prior ?? { status: 'next', brief: '', rounds: [], decisions: [], at };
  return {
    ...doc,
    facts: { ...doc.facts, build: { ...build, rounds: [...build.rounds, round].slice(-KEPT_ROUNDS) } },
  };
}
