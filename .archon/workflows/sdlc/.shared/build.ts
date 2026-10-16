/**
 * The build queue's record on an item's work item: `facts.build`.
 *
 * It is the queue's memory of the item: every round it ran (one archon-ship run), every
 * decision it made with the person's answer when it asked, and what happens next. The
 * deciding agents read it before deciding, and the queue's pickup reads `status` to
 * know whether the item waits for it.
 */

import type { Attention, DecisionEntry } from './queue.ts';
import type { Pickup, Stage, WorkItem } from './workitem.ts';

/** What a build choice does when a person picks it; archon-build-queue.yaml declares the same enum. */
export const BUILD_EFFECTS = ['continue', 'park'] as const;
export type BuildEffect = (typeof BUILD_EFFECTS)[number];
export type BuildAttention = Attention<BuildEffect>;

/** The decision each agent can declare; archon-build-queue.yaml declares the same enums. */
export const ROUTE_DECISIONS = ['launch', 'ask'] as const;
export const ANSWER_DECISIONS = ['done', 'continue', 'ask'] as const;
export const GIVE_UP_DECISIONS = ['continue', 'ask'] as const;
export const BUILD_PATHS = ['idle', 'closed', 'route', 'answer'] as const;
export type BuildPath = (typeof BUILD_PATHS)[number];
/** Which decision raised an attention item: its class label. */
export type AskedBy = 'route' | 'stop' | 'scope';

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
 * `next`: the item waits for its next launch, from `brief`. `asking`: a run is paused
 * on the item's attention item. `ready`: its pull request is reviewed and ready.
 * `parked`: the queue stopped working it, until a re-triage.
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
 * The rounds that count toward the give-up decision: those since the item's scope last
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

export interface BuildChange {
  readonly at: string;
  readonly run_id: string;
  readonly round: BuildRound | null;
  readonly entry: DecisionEntry;
  readonly status: BuildStatus;
  readonly brief: string;
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
