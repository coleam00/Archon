/**
 * The build queue's record on an item's work item: `facts.build`.
 *
 * It is the queue's memory of the item: every round it ran (one archon-ship run), every
 * decision it made with the person's answer when it asked, and what happens next. The
 * deciding agents read it before deciding, and the queue's pickup reads `status` to
 * know whether the item waits for it.
 */

import { type QualifiedPr, sameRepo } from './forge.ts';
import { note } from './io.ts';
import { PR_CREATE_UNRESOLVED } from './pr.ts';
import type { Attention, Choice, DecisionEntry } from './queue.ts';
import { stateDocuments, statePut } from './state.ts';
import {
  claimable,
  claimItem,
  type HistoryEntry,
  newest,
  type Pickup,
  parseWorkItem,
  read,
  releaseIfTerminal,
  type Stage,
  type TriageFacts,
  type WorkItem,
  workItemName,
} from './workitem.ts';

/**
 * What a build choice does when a person picks it; archon-build-queue.yaml declares the
 * same enum. `continue` launches the next round from the brief. `ready` hands the pull
 * request to the merge queue as it stands, such as after a maintainer finished it by
 * hand. `wait` parks the item on the issues or pull requests the choice names in
 * `blockers` until they all close or merge. `park` stops work until a re-triage.
 */
export const BUILD_EFFECTS = ['continue', 'ready', 'wait', 'park'] as const;
export type BuildEffect = (typeof BUILD_EFFECTS)[number];
/** A build choice; a `wait` choice also names the issue or pull request numbers, in the item's repository, it waits on. */
export type BuildChoice = Choice<BuildEffect> & { readonly blockers?: readonly number[] };
export type BuildAttention = Omit<Attention<BuildEffect>, 'choices'> & { readonly choices: readonly BuildChoice[] };

/** The decision each agent can declare; archon-build-queue.yaml declares the same enums. */
export const ROUTE_DECISIONS = ['launch', 'ask', 'ready'] as const;
export const ANSWER_DECISIONS = ['done', 'continue', 'ask'] as const;
export const BUILD_PATHS = ['idle', 'closed', 'route'] as const;
export type BuildPath = (typeof BUILD_PATHS)[number];
/** What apply reports the run decided; archon-build-queue.yaml declares the same enum. */
export const APPLY_DECISIONS = ['idle', 'parked', 'ready', 'continue', 'asked', 'launch'] as const;
export type ApplyDecision = (typeof APPLY_DECISIONS)[number];
/** Which decision raised an attention item: its class label, which the YAML also declares. */
export const ASKED_BY = ['route', 'stop', 'scope'] as const;
export type AskedBy = (typeof ASKED_BY)[number];

/** The stages a triaged item can be launched from: a READY verdict's routes. */
export const LAUNCH_STAGES = [
  'investigate',
  'plan',
  'deliver',
  'continue',
] as const satisfies readonly Stage[];

/** One archon-ship run the queue launched, as its terminal report ended it. */
export interface BuildRound {
  readonly run_id: string;
  readonly at: string;
  readonly delivered: boolean;
  readonly reason: string;
  readonly pr_url: string;
  readonly summary: string;
  readonly artifacts: string;
}

/**
 * Who owns the item, as the build queue last recorded it. `next`: the build queue, for
 * its next launch from `brief`. `asking`: the build queue, paused on the item's
 * attention item. `ready`: handed to the merge queue, which owns its pull request from
 * here. `parked`: no queue, until a re-triage, or, with `blockers`, until they settle.
 */
export type BuildStatus = 'next' | 'asking' | 'ready' | 'parked';

export interface BuildRecord {
  readonly status: BuildStatus;
  /** What the next launch starts from; empty unless the status is `next`. */
  readonly brief: string;
  /** The issues or pull requests, in the item's repository, a `wait` answer parked the item on. */
  readonly blockers?: readonly number[];
  readonly rounds: readonly BuildRound[];
  readonly decisions: readonly DecisionEntry[];
  /** When the queue last decided the item. */
  readonly at: string;
}

// Rounds, decisions and their prose are capped so the record keeps the work item well
// under the state store's 64 KiB limit. `archon state log` keeps every revision.
const KEPT_ROUNDS = 10;
const KEPT_DECISIONS = 20;
const KEPT_TEXT = 1500;

function clipped(text: string): string {
  return text.length <= KEPT_TEXT ? text : `${text.slice(0, KEPT_TEXT)}…`;
}

/** Whether an unclaimed item waits for the build queue. */
export function buildWaits(doc: WorkItem): boolean {
  if (!(LAUNCH_STAGES as readonly string[]).includes(doc.stage)) return false;
  const build = doc.facts.build;
  if (build === undefined || build.status === 'next') return true;
  // A re-triage after the queue's last decision starts the item over.
  return (doc.facts.triage?.at ?? '') > build.at;
}

export const BUILD_PICKUP: Pickup = { stage: 'build', waits: buildWaits, takesRequests: false };

/**
 * Claim the named item for the build queue, releasing a terminal claim on it first as
 * `claimNext` does. Refuses with the facts an operator acts on when it cannot.
 */
export function claimNamed(number: number, at: string, runId: string): WorkItem {
  const issue = `issue ${String(number)}`;
  const found = read(workItemName(number));
  if (found === undefined) throw new Error(`${issue} has no work item: intake has not recorded it`);
  const item = releaseIfTerminal(found, at, runId, BUILD_PICKUP);
  const won = claimable(item, BUILD_PICKUP) ? claimItem(item, at, runId, BUILD_PICKUP) : null;
  if (won !== null) return won;
  const now = read(item.name) ?? item;
  if (now.doc.claim !== null) throw new Error(`${issue} is claimed by run ${now.doc.claim.run_id}`);
  // Both conditional writes can lose to concurrent writes that leave the item waiting.
  if (buildWaits(now.doc)) throw new Error(`${issue} kept changing while this run claimed it; launch it again`);
  const status = now.doc.facts.build?.status ?? 'none';
  throw new Error(`${issue} does not wait for the build queue: stage ${now.doc.stage}, build status ${status}`);
}

/** A blocked item for the revisit agent: which issue, and intake's summary of why it is blocked. */
export interface BlockedItem {
  readonly number: number;
  readonly summary: string;
}

// A scheduled queue would otherwise judge the same blocked items on every run.
const REVISIT_EVERY_MS = 6 * 60 * 60 * 1000;
const REVISITED = 'revisited';

/** The unclaimed blocked items the queue has not revisited in the last few hours. */
export function dueBlocked(at: string): BlockedItem[] {
  const due = new Date(Date.parse(at) - REVISIT_EVERY_MS).toISOString();
  const items: BlockedItem[] = [];
  for (const stored of stateDocuments('work/')) {
    if (stored.value === null) continue;
    let doc: WorkItem;
    try {
      doc = parseWorkItem(stored.value);
    } catch (error) {
      note(`revisit skips ${stored.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const last = doc.history.filter(entry => entry.outcome === REVISITED).at(-1)?.at ?? '';
    if (doc.stage !== 'blocked' || doc.claim !== null || last >= due) continue;
    const triaged = doc.history.filter(entry => entry.outcome === 'blocked').at(-1);
    items.push({ number: doc.subject.number, summary: triaged?.summary ?? '' });
  }
  return items;
}

/** Record that the queue revisited the item, re-reading on a conflict; false if it never landed. */
export function recordRevisit(subject: QualifiedPr, runId: string, summary: string): boolean {
  const entry: HistoryEntry = { at: new Date().toISOString(), stage: 'build', run_id: runId, outcome: REVISITED, summary };
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = read(workItemName(subject.number));
    if (stored === undefined) return false;
    const doc = { ...stored.doc, history: newest([...stored.doc.history, entry]) };
    if (statePut(stored.name, doc, stored.revision) === 'ok') return true;
  }
  return false;
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
  const url = rounds.filter(round => round.pr_url !== '').at(-1)?.pr_url;
  return url === undefined ? triaged : { repo, number: roundPrNumber(url, repo) };
}

function roundPrNumber(url: string, repo: QualifiedPr['repo']): number {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  const match = parsed === null ? null : /^\/(.+)\/pull\/([1-9][0-9]*)$/.exec(parsed.pathname);
  if (
    parsed === null ||
    match === null ||
    !sameRepo({ host: parsed.hostname, path: match[1] ?? '' }, repo)
  ) {
    throw new Error(`round pr_url ${url} is not a pull request of ${repo.host}/${repo.path}`);
  }
  return Number(match[2]);
}

/**
 * The branch a round with no pull request to continue opens one from. The run-id
 * suffix keeps a name from being reused: after a closed pull request or a failed
 * create, the non-forcing push onto the old branch would refuse every round.
 */
/** Every round's branch starts with this, so a pull request from such a branch is the build queue's. */
export const BUILD_BRANCH_PREFIX = 'build/';

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
  /** What a `wait` answer parks the item on; recorded only when non-empty. */
  readonly blockers?: readonly number[];
  /** Clear the claim in the same write: nothing is left for this run to do. */
  readonly release: boolean;
}

/** The work item with one decision recorded on it. */
export function withBuild(doc: WorkItem, change: BuildChange): WorkItem {
  const prior = doc.facts.build;
  const round = change.round === null ? [] : [{ ...change.round, summary: clipped(change.round.summary) }];
  const entry = { ...change.entry, reason: clipped(change.entry.reason) };
  const build: BuildRecord = {
    status: change.status,
    brief: change.status === 'next' ? change.brief : '',
    ...(change.blockers === undefined || change.blockers.length === 0 ? {} : { blockers: change.blockers }),
    rounds: [...(prior?.rounds ?? []), ...round].slice(-KEPT_ROUNDS),
    decisions: [...(prior?.decisions ?? []), entry].slice(-KEPT_DECISIONS),
    at: change.at,
  };
  return {
    ...doc,
    claim: change.release ? null : doc.claim,
    facts: { ...doc.facts, build },
    links: { runs: [...doc.links.runs.filter(id => id !== change.run_id), change.run_id].slice(-50) },
  };
}

/** A blocker as the forge reports it, or why it could not be read. */
export type BlockerState = 'open' | 'closed' | 'merged' | { readonly unreadable: string };

/**
 * Wake every unclaimed item a `wait` answer parked whose blockers all closed or merged:
 * its status goes back to `next`, with a brief naming what settled. Returns the woken
 * issue numbers, and one line for each item a blocker it could not read keeps parked.
 */
export function wakeSettled(at: string, runId: string, stateOf: (blocker: QualifiedPr) => BlockerState): { woken: number[]; unreadable: string[] } {
  const woken: number[] = [];
  const unreadable: string[] = [];
  for (const item of stateDocuments('work/').flatMap(stored => read(stored.name, stored) ?? [])) {
    const build = item.doc.facts.build;
    const blockers = build?.status === 'parked' && item.doc.claim === null ? (build.blockers ?? []) : [];
    if (blockers.length === 0) continue;
    const states = blockers.map(number => ({ number, state: stateOf({ repo: item.doc.subject.repo, number }) }));
    const failed = states.flatMap(({ number, state }) => (typeof state === 'object' ? [`#${String(number)}: ${state.unreadable}`] : []));
    if (failed.length > 0) {
      unreadable.push(`issue ${String(item.doc.subject.number)} stays parked: blocker ${failed.join('; ')} could not be read`);
      continue;
    }
    if (states.some(blocker => blocker.state === 'open')) continue;
    const settled = states.map(blocker => `#${String(blocker.number)} ${String(blocker.state)}`).join(', ');
    const doc = withBuild(item.doc, {
      at,
      run_id: runId,
      round: null,
      entry: { at, run_id: runId, decision: 'woken', reason: `its blockers settled: ${settled}`, links: [] },
      status: 'next',
      brief: `The item waited on ${settled}; those have settled. Continue from the issue body, its dated "Current scope" sections and the recorded decisions.`,
      release: false,
    });
    // A conflict means another run moved the item; the next pass reads it again.
    if (statePut(item.name, doc, item.revision) === 'ok') woken.push(item.doc.subject.number);
  }
  return { woken, unreadable };
}
