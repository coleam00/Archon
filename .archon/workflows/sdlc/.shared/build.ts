/**
 * The build queue's record on an item's work item: `facts.build`.
 *
 * It is the queue's memory of the item: every round it ran (one build-queue run), every
 * decision it made with the person's answer when it asked, and what happens next. The
 * deciding agents read it before deciding, and `buildWaits` reads `status` to know
 * whether the item waits for a round.
 */

import { input, state, trigger } from 'archon:script';
import { type QualifiedPr, sameRepo } from './identity.ts';
import type { NodeOutput } from './outputs.generated.ts';
import { PR_CREATE_UNRESOLVED, prFromUrl } from './pr.ts';
import { clipped, type DecisionEntry, withDecision } from './queue.ts';
import {
  type HistoryEntry,
  itemKey,
  newest,
  parseWorkItem,
  readWorkItem,
  type Stage,
  type TriageFacts,
  type WorkItem,
} from './workitem.ts';

/** The question a deciding agent writes, as archon-build-queue.yaml declares it. */
export type BuildAsk = NonNullable<NodeOutput<'archon-build-queue', 'route'>['ask']>;

/**
 * What a build choice does when a person picks it. `continue` launches the next round
 * from the brief. `ready` hands the pull request to the merge queue as it stands, such
 * as after a maintainer finished it by hand. `park` stops work until a re-triage.
 */
export type BuildEffect = BuildAsk['options'][number]['effect'];

/** Which decision raised an ask: its `kind` label, which the YAML also declares. */
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
 * its next launch from `brief`. `asking`: the build queue, whose ask is open on the
 * item; the answer starts the next run. `ready`: handed to the merge queue, which owns its pull request from
 * here. `parked`: no queue, until a re-triage.
 */
export type BuildStatus = 'next' | 'asking' | 'ready' | 'parked';

export interface BuildRecord {
  readonly status: BuildStatus;
  /** What the next launch starts from; empty unless the status is `next`. */
  readonly brief: string;
  readonly rounds: readonly BuildRound[];
  readonly decisions: readonly DecisionEntry[];
  /**
   * When the run that last decided the item read it. A re-triage after that, even one
   * made while the round ran, starts the item over.
   */
  readonly at: string;
}

// Rounds, decisions and their prose are capped so the record keeps the work item well
// under the state store's 64 KiB limit. `archon state log` keeps every revision.
export const KEPT_ROUNDS = 10;
/** Whether the item waits for a build round. */
export function buildWaits(doc: WorkItem): boolean {
  if (!(LAUNCH_STAGES as readonly string[]).includes(doc.stage)) return false;
  const build = doc.facts.build;
  if (build === undefined || build.status === 'next') return true;
  // A re-triage after the queue's last round began starts the item over.
  return (doc.facts.triage?.at ?? '') > build.at;
}

/**
 * The item's document when it waits for a build round. Throws the reason an operator
 * acts on when it has none or does not wait.
 */
export function waitingItem(number: number): WorkItem {
  const issue = `issue ${String(number)}`;
  const doc = readWorkItem(number);
  if (doc === null) throw new Error(`${issue} has no work item: intake has not recorded it`);
  if (buildWaits(doc)) return doc;
  const status = doc.facts.build === undefined ? '' : `, build status ${doc.facts.build.status}`;
  throw new Error(`${issue} does not wait for the build queue: stage ${doc.stage}${status}`);
}

/**
 * A blocked item for the revisit agent: which issue, intake's summary of why it is
 * blocked, when triage gave that verdict, and what the verdict said it waits on. An item
 * blocked before verdicts stored that carries an empty reason and no blockers.
 */
export interface BlockedItem {
  readonly number: number;
  readonly summary: string;
  readonly blocked_at: string;
  readonly blocked_reason: string;
  readonly blocked_by: readonly string[];
}

// A scheduled queue would otherwise judge the same blocked items on every run.
const REVISIT_EVERY_MS = 6 * 60 * 60 * 1000;
const REVISITED = 'revisited';

function blockedItem(doc: WorkItem): BlockedItem {
  const triage = doc.facts.triage;
  return {
    number: doc.subject.number,
    summary: doc.history.filter(entry => entry.outcome === 'blocked').at(-1)?.summary ?? '',
    blocked_at: triage?.at ?? '',
    blocked_reason: triage?.blocked?.reason ?? '',
    blocked_by: triage?.blocked?.by ?? [],
  };
}

/**
 * The unclaimed blocked items no run has revisited in the last few hours, each recorded
 * as revisited by this run before it is listed. The record is a conditional write at the
 * revision read, so of several runs that list at once exactly one gets each item; a run
 * whose write loses leaves the item to the run that won.
 */
export function dueBlocked(at: string, runId: string): BlockedItem[] {
  const due = new Date(Date.parse(at) - REVISIT_EVERY_MS).toISOString();
  const items: BlockedItem[] = [];
  for (const stored of state.listValues('work/')) {
    if (stored.value === null) continue;
    let doc: WorkItem;
    try {
      doc = parseWorkItem(stored.value);
    } catch (error) {
      console.error(`revisit skips ${stored.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const last = doc.history.filter(entry => entry.outcome === REVISITED).at(-1)?.at ?? '';
    if (doc.stage !== 'blocked' || doc.claim !== null || last >= due) continue;
    const entry: HistoryEntry = { at, stage: 'build', run_id: runId, outcome: REVISITED, summary: 'listed for the revisit agent' };
    if (!state.put(stored.name, { ...doc, history: newest([...doc.history, entry]) }, { ifRevision: stored.revision }).ok) {
      console.error(`revisit leaves ${stored.name} to the run that changed it`);
      continue;
    }
    items.push(blockedItem(doc));
  }
  return items;
}

/**
 * Start one intake pickup of `subject` from a build pick: a fire of the operator's
 * intake binding (the pick's `intake_binding`) on the issue's item, under intake's
 * resource, capacity and overlap policy. The delivery id names the run, so a retried
 * node starts no second pickup. `action` is `retriage` for a run's re-triage request.
 * Returns how the binding admitted it, for the run's summary.
 */
export function startIntake(subject: QualifiedPr, runId: string, action?: 'retriage'): string {
  const binding = input('intake_binding').trim();
  if (binding === '') throw new Error('intake_binding is empty; a pick starts intake only through that binding');
  const { repo, number } = subject;
  const fired = trigger.fire(
    binding,
    { repo_host: repo.host, repo_path: repo.path, number: String(number), ...(action === undefined ? {} : { action }) },
    { deliveryId: `build-pick-intake:${repo.host}/${repo.path}#${String(number)}:${runId}`, item: itemKey(number) }
  );
  return fired.disposition?.status ?? 'not admitted';
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
  /** The record's `at`: when the deciding run read the item. */
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
