/**
 * The merge queue's record on an item's work item, `facts.merge`, and the pull-request
 * facts its gate reads before every merge.
 *
 * The merge queue takes the items the build queue finished: a work item whose
 * `facts.build` is `ready`. Its pull request is the latest one a build round recorded,
 * or, when none did, the one triage routed the item to continue. The queue claims them
 * with intake's claim, so an item has one owner at a time across the three queues.
 *
 * Every read and the merge go through the forge contract (./forge.ts), using the
 * operations in `MERGE_QUEUE_FORGE_OPERATIONS`.
 */

import { itemPullRequest, type Validation } from './build.ts';
import { invokeForge, record, REMEDY, type QualifiedPr } from './forge.ts';
import { viewPr } from './pr.ts';
import { type Attention, type DecisionEntry, withDecision } from './queue.ts';
import { type ContractCoverage, readReviewStamp } from './review-comment.ts';
import type { Pickup, WorkItem } from './workitem.ts';

/** What a merge choice does when a person picks it; archon-merge-queue.yaml declares the same enum. */
export const MERGE_EFFECTS = ['merge', 'return', 'park'] as const;
export type MergeEffect = (typeof MERGE_EFFECTS)[number];
export type MergeAttention = Attention<MergeEffect>;

/** The one answer to a red default branch: the queue holds merges until it is green again. */
export const BASE_EFFECTS = ['hold'] as const;
export type BaseAttention = Attention<(typeof BASE_EFFECTS)[number]>;

/** The sweep's decision on one pull request; archon-merge-queue.yaml declares the same enums. */
export type SweepAction = 'merged' | 'return' | 'ask' | 'wait';
export const POLICY_CLASSES = ['clear', 'unclear'] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];
export const MERGE_PATHS = ['idle', 'record', 'sweep'] as const;
export type MergePath = (typeof MERGE_PATHS)[number];
/** Which attention item a run raised: its class label, which the YAML also declares. */
export type MergeAskedBy = 'pr' | 'base';
/** What the record node asked, which the ruling node needs to act on the answer. */
export type MergeAsked =
  | {
      readonly by: Extract<MergeAskedBy, 'pr'>;
      readonly item: QualifiedPr;
      readonly pr: QualifiedPr;
      readonly head: string;
      readonly brief: string;
      readonly attention: MergeAttention;
    }
  | { readonly by: Extract<MergeAskedBy, 'base'>; readonly attention: BaseAttention };
export const MERGE_METHODS = ['squash', 'merge'] as const;
/** The pack's `ci` setting; `.pack/pack.yaml` declares the same values. */
export const CI_MODES = ['forge', 'none'] as const;
export type CiMode = (typeof CI_MODES)[number];

/** What the gate trusts at the head besides the verdict: forge checks, or a recorded validation. */
export type CiTrust =
  | { readonly mode: Extract<CiMode, 'forge'> }
  | { readonly mode: Extract<CiMode, 'none'>; readonly validation: Validation | null };

/** The `ci` setting as a run reads it; anything else refuses. */
export function parseCiMode(value: string): CiMode {
  const mode = CI_MODES.find(candidate => candidate === value);
  if (mode === undefined) throw new Error(`the ci setting must be one of ${CI_MODES.join(', ')}, not "${value}"`);
  return mode;
}
export type MergeMethod = (typeof MERGE_METHODS)[number];

/**
 * `waiting`: the next sweep decides it. `asking`: a run is paused on its attention item.
 * `merged`: this PR merged; a later build may ready another. `returned`: handed back
 * to the build queue, which owns it until it is ready again. `parked`: the queue
 * stopped working it until renewed build readiness.
 */
export type MergeStatus = 'waiting' | 'asking' | 'merged' | 'returned' | 'parked';

/**
 * One merge decision. `head` is the commit it was about, null when the queue settled
 * the item without reading one; `reran` says the queue re-ran its failed checks at that
 * head, which it does at most once per head.
 */
export interface MergeDecisionEntry extends DecisionEntry {
  readonly head: string | null;
  readonly reran: boolean;
  /** On a `wait` the sweep declared: the facts it waited on (`waitedOn`). */
  readonly waited_on?: string;
}

export interface MergeRecord {
  readonly status: MergeStatus;
  readonly pr: QualifiedPr | null;
  /** A maintainer's approval to merge, pinned to the head they approved. */
  readonly approval: { readonly head: string; readonly at: string } | null;
  readonly decisions: readonly MergeDecisionEntry[];
  /** When the queue last decided the item. */
  readonly at: string;
}

export function answeredMergeDecision(effect: MergeEffect): `answered: ${MergeEffect}` {
  return `answered: ${effect}`;
}

/**
 * Renewed build readiness waits again after settlement; an abandoned ask waits once
 * its claim is released.
 */
export function mergeWaits(doc: WorkItem): boolean {
  const build = doc.facts.build;
  if (build?.status !== 'ready') return false;
  const merge = doc.facts.merge;
  if (merge === undefined || merge.status === 'waiting' || merge.status === 'asking') return true;
  return build.at > merge.at;
}

/**
 * The decision label of an item settled `waiting` because its pull request could not be
 * read. A second one in a row parks the item instead, so a pull request that can never
 * be read is reported rather than claimed by every sweep.
 */
export const UNREADABLE = 'waiting (unreadable)';

/** A claimed item the facts node settled without the sweep, which the record node writes. */
export interface MergeSettled {
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr | null;
  readonly status: Extract<MergeStatus, 'merged' | 'parked' | 'waiting'>;
  /** The decision label recorded. */
  readonly decision: string;
  readonly reason: string;
}

export const MERGE_PICKUP: Pickup = { stage: 'merge', waits: mergeWaits, takesRequests: false };

/**
 * The item's pull request as the build queue resolves it (its latest round's, else the
 * one triage routed it to continue), or null.
 */
export function itemPr(doc: WorkItem): QualifiedPr | null {
  return itemPullRequest(doc.facts.build?.rounds ?? [], doc.facts.triage, doc.subject.repo);
}

export interface MergeChange {
  readonly at: string;
  readonly run_id: string;
  readonly entry: MergeDecisionEntry;
  readonly status: MergeStatus;
  readonly pr: QualifiedPr | null;
  /** Undefined keeps the approval already recorded. */
  readonly approval?: MergeRecord['approval'];
  /** Clear the claim in the same write: nothing is left for this run to do. */
  readonly release: boolean;
}

/** The work item with one merge decision recorded on it. */
export function withMerge(doc: WorkItem, change: MergeChange): WorkItem {
  const prior = doc.facts.merge;
  const merge: MergeRecord = {
    status: change.status,
    pr: change.pr,
    approval: change.approval === undefined ? (prior?.approval ?? null) : change.approval,
    decisions: withDecision(prior?.decisions, change.entry),
    at: change.at,
  };
  return {
    ...doc,
    claim: change.release ? null : doc.claim,
    facts: { ...doc.facts, merge },
    links: { runs: [...doc.links.runs.filter(id => id !== change.run_id), change.run_id].slice(-50) },
  };
}

// --- the facts the gate reads -----------------------------------------------------

export const CHECK_STATES = ['none', 'pending', 'green', 'red'] as const;
export interface Checks {
  readonly state: (typeof CHECK_STATES)[number];
  readonly failing: readonly string[];
  readonly pending: readonly string[];
}

/**
 * `none`: no trusted review comment. `unstamped`: published before the verdict was
 * stamped, so it carries no verdict a script can read. `duplicate`: more than one
 * trusted review comment, so none of them is the canonical one.
 */
export const VERDICT_STATES = ['none', 'unstamped', 'duplicate', 'ready', 'not_ready'] as const;
export interface Verdict {
  readonly state: (typeof VERDICT_STATES)[number];
  /** The commit the verdict is about. */
  readonly reviewed: string | null;
  readonly url: string | null;
  /** The stamped contract coverage; null when the comment predates the stamp or none is trusted. */
  readonly contract: ContractCoverage | null;
}

const MERGEABLE = ['clean', 'conflict', 'unknown'] as const;

export interface PrFacts {
  readonly pr: QualifiedPr;
  readonly url: string;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly is_draft: boolean;
  readonly base: string;
  readonly default_branch: string;
  /** The default branch's head when the pull request was read. */
  readonly default_head: string;
  /** How many commits of the default branch at `default_head` the pull request's head lacks. */
  readonly behind: number;
  readonly head: string;
  readonly head_revision: string;
  readonly merge_commit: string | null;
  readonly mergeable: (typeof MERGEABLE)[number];
  readonly checks: Checks;
  readonly threads: { readonly unresolved: number; readonly urls: readonly string[] };
  readonly verdict: Verdict;
}

/**
 * The facts a `wait` can end on: the head, whether it is a draft, whether it merges,
 * the state of its checks, its open threads, its verdict, and the default branch's head
 * and check state. While they read the same as when the sweep declared the wait, the
 * agent would decide the same, so the item is not handed to it again.
 */
export function waitedOn(facts: PrFacts, base: BaseFacts | null): string {
  return JSON.stringify([
    facts.head_revision,
    facts.is_draft,
    facts.mergeable,
    facts.checks.state,
    [...facts.threads.urls].sort(),
    facts.verdict.state,
    facts.verdict.reviewed,
    facts.default_head,
    base?.checks.state ?? null,
  ]);
}

/** The forge operations the merge queue reads and merges through. */
export const MERGE_QUEUE_FORGE_OPERATIONS = [
  'pr.view',
  'pr.merge',
  'pr.threads',
  'checks.state',
  'checks.commit',
  'checks.rerun',
  'pr.merge-state',
  'workitem.comments',
] as const;

/**
 * Refuse a plugin that lacks a merge-queue operation before anything is
 * claimed: every pull request it could not read would otherwise wait, then park.
 */
export function requireMergeSource(repo: QualifiedPr['repo']): void {
  const capabilities = invokeForge('metadata', { host: repo.host })?.capabilities;
  if (!Array.isArray(capabilities)) throw new Error('forge metadata returned no operation capabilities');
  const missing = MERGE_QUEUE_FORGE_OPERATIONS.filter(op => !capabilities.includes(op));
  if (missing.length > 0) {
    throw new Error(`the forge plugin for ${repo.host} lacks the merge queue's ${missing.join(', ')}. ${REMEDY.unsupported_op}`);
  }
}

export interface BaseFacts {
  readonly branch: string;
  readonly head: string;
  readonly checks: Checks;
}

/** The default branch, its head commit and the checks on it. */
export function readBase(repo: QualifiedPr['repo']): BaseFacts {
  const value = invokeForge('checks.commit', { repo, at: { kind: 'default_branch' } });
  if (typeof value?.branch !== 'string' || typeof value.revision !== 'string') {
    throw new Error(`${repo.path} reports no default branch`);
  }
  return { branch: value.branch, head: value.revision, checks: checksOf(value.units) };
}

interface Comment {
  readonly body: string;
  readonly url: string;
  /** Null for a deleted account. */
  readonly author: string | null;
}

/**
 * The trusted review comment: the one marked comment a listed maintainer wrote. A
 * marked comment anyone else wrote is ignored, so an outside commenter cannot forge a
 * verdict on a public repository.
 */
function trustedReview(comments: readonly Comment[], maintainers: ReadonlySet<string>): Verdict {
  const reviews = comments.flatMap(comment => {
    const stamp = readReviewStamp(comment.body);
    const trusted = comment.author !== null && maintainers.has(comment.author.toLowerCase());
    return stamp !== null && trusted ? [{ stamp, url: comment.url }] : [];
  });
  const [review, ...others] = reviews;
  if (review === undefined) return { state: 'none', reviewed: null, url: null, contract: null };
  if (others.length > 0) return { state: 'duplicate', reviewed: null, url: null, contract: null };
  const state = review.stamp.ready === null ? 'unstamped' : review.stamp.ready ? 'ready' : 'not_ready';
  return { state, reviewed: review.stamp.reviewed, url: review.url, contract: review.stamp.contract };
}

/** The commit the pull request's trusted review comment names, or null when it has none. */
export function reviewedHead(pr: QualifiedPr, maintainers: ReadonlySet<string>): string | null {
  const verdict = trustedReview(readComments(pr), maintainers);
  if (verdict.state === 'duplicate') throw new Error(`pull request ${String(pr.number)} has more than one trusted review comment`);
  return verdict.reviewed;
}

/**
 * The forge's check units on one commit: only a green unit passes, so a gated or
 * unknown one is failing.
 */
function checksOf(units: unknown): Checks {
  if (!Array.isArray(units)) throw new Error('forge returned no check units');
  const failing: string[] = [];
  const pending: string[] = [];
  for (const raw of units) {
    const unit = record(raw);
    const name = record(unit?.unit)?.name;
    if (typeof name !== 'string' || typeof unit?.state !== 'string') throw new Error('forge returned a check unit without its name and state');
    if (unit.state === 'pending') pending.push(name);
    else if (unit.state !== 'green') failing.push(name);
  }
  const state = failing.length > 0 ? 'red' : pending.length > 0 ? 'pending' : units.length === 0 ? 'none' : 'green';
  return { state, failing, pending };
}

/** How far `head` is behind the default branch and whether it merges, read at that head. */
function readMergeState(ref: QualifiedPr, url: string, head: string) {
  const value = invokeForge('pr.merge-state', { ref });
  const mergeable = MERGEABLE.find(state => state === value?.mergeable);
  if (
    typeof value?.head_revision !== 'string' ||
    typeof value.default_branch !== 'string' ||
    typeof value.default_revision !== 'string' ||
    typeof value.behind !== 'number' ||
    mergeable === undefined ||
    !(typeof value.merge_commit === 'string' || value.merge_commit === null)
  ) {
    throw new Error(`forge pr.merge-state returned an incomplete answer for ${url}`);
  }
  if (value.head_revision !== head) throw new Error(`the head of ${url} moved while it was read`);
  return {
    default_branch: value.default_branch,
    default_head: value.default_revision,
    behind: value.behind,
    mergeable,
    merge_commit: value.merge_commit,
  };
}

function readThreads(ref: QualifiedPr): PrFacts['threads'] {
  const threads = invokeForge('pr.threads', { ref })?.threads;
  if (!Array.isArray(threads)) throw new Error('forge pr.threads returned no thread list');
  const unresolved = threads.map(record).filter(thread => {
    if (typeof thread?.resolved !== 'boolean') throw new Error('forge pr.threads returned a thread without its resolution');
    return !thread.resolved;
  });
  return {
    unresolved: unresolved.length,
    urls: unresolved.map(thread => {
      const first = record(Array.isArray(thread?.comments) ? thread.comments[0] : undefined)?.url;
      return typeof first === 'string' ? first : '';
    }),
  };
}

function readComments(ref: QualifiedPr): Comment[] {
  const comments = invokeForge('workitem.comments', { subject: { kind: 'pr', ref } })?.comments;
  if (!Array.isArray(comments)) throw new Error('forge workitem.comments returned no comment list');
  return comments.map(raw => {
    const comment = record(raw);
    if (typeof comment?.body !== 'string' || typeof comment.url !== 'string' || !('author' in comment)) {
      throw new Error('forge workitem.comments returned a comment without its body, URL and author');
    }
    const login = record(comment.author)?.login;
    return { body: comment.body, url: comment.url, author: typeof login === 'string' && login !== '' ? login : null };
  });
}

/**
 * One snapshot of everything the gate and the sweep read about a pull request. Each
 * read that names a commit must name the head.
 */
export function readPr(pr: QualifiedPr, maintainers: ReadonlySet<string>): PrFacts {
  const ref = { repo: pr.repo, number: pr.number };
  const view = viewPr(ref);
  const { url, head_revision: head } = view.pr;
  if (head === null) throw new Error(`${url} reports no head commit`);
  const mergeState = readMergeState(ref, url, head);
  const checks = invokeForge('checks.state', { ref });
  if (checks?.revision !== head) throw new Error(`the checks read for ${url} are not on its head`);
  return {
    pr,
    url,
    title: view.title,
    state: view.pr.state,
    is_draft: view.pr.is_draft,
    base: view.pr.base,
    head: view.pr.head,
    head_revision: head,
    ...mergeState,
    checks: checksOf(checks.units),
    threads: readThreads(ref),
    verdict: trustedReview(readComments(ref), maintainers),
  };
}

/** Why what the `ci` setting trusts does not pass at `head`, or null when it does. */
function ciRefusal(checks: Checks, head: string, ci: CiTrust): string | null {
  if (ci.mode === 'forge') {
    if (checks.state === 'green') return null;
    const named = [...checks.failing, ...checks.pending];
    return `CI at its head is ${checks.state}${named.length === 0 ? '' : ` (${named.join(', ')})`}`;
  }
  const { validation } = ci;
  if (validation === null) return 'no validation is recorded for it';
  if (validation.head !== head) return `its validation is for ${validation.head}, not ${head}`;
  return validation.passed ? null : `its validation at ${head} failed`;
}

/**
 * Why the pull request may not merge at `head`; empty when it may. The facts the
 * queue's contract names are a Ready verdict given at the head and what the project's
 * `ci` setting trusts there, on a default branch whose CI is not red: green forge checks
 * under `forge`, a passing validation delivery recorded at that same head under `none`.
 * The queue never pushes, so a verdict for another commit
 * means someone else pushed after the review. Pending CI on the default branch
 * does not hold a merge: the next sweep reads its result. Whether an open review thread
 * holds the merge is the sweep's judgment, from the thread facts it reads. The rest keep
 * the merge on an open, non-draft pull request into the default branch at exactly the
 * commit that was judged, and that commit either containing the default branch's head
 * or merging into it with no conflict.
 */
export function gateRefusals(
  facts: PrFacts,
  head: string,
  base: { readonly head: string; readonly checks: Checks },
  ci: CiTrust
): string[] {
  const refusals: string[] = [];
  if (facts.state !== 'open') refusals.push(`it is ${facts.state}`);
  if (facts.is_draft) refusals.push('it is a draft');
  if (facts.base !== facts.default_branch) {
    refusals.push(`it targets ${facts.base}, not the default branch ${facts.default_branch}`);
  }
  if (facts.head_revision !== head) refusals.push(`its head is ${facts.head_revision}, not ${head}`);
  if (facts.behind > 0 && facts.mergeable !== 'clean') {
    refusals.push(
      `it lacks ${String(facts.behind)} commits of ${facts.default_branch} at ${facts.default_head} and its merge is ${facts.mergeable}`
    );
  }
  const { verdict } = facts;
  if (verdict.state !== 'ready') refusals.push(`its review verdict is ${verdict.state}`);
  else if (verdict.reviewed !== head) refusals.push(`its review verdict is for ${String(verdict.reviewed)}, not ${head}`);
  const unvalidated = ciRefusal(facts.checks, head, ci);
  if (unvalidated !== null) refusals.push(unvalidated);
  if (base.checks.state === 'red') {
    refusals.push(`the default branch ${facts.default_branch} is red at ${base.head} (${base.checks.failing.join(', ')})`);
  }
  return refusals;
}

/**
 * Merge at exactly `head`; the forge refuses when the head has moved since it was read.
 * An applied merge was read back by the forge, which returns the commit it landed as.
 * A merge the plugin cannot verify throws its outcome, which fails the gate, and so does
 * an applied one that names no landed commit: the contract allows a null commit, and
 * nothing then shows the merge landed.
 */
export function mergeAtHead(pr: QualifiedPr, head: string, method: MergeMethod): string {
  const merged = invokeForge('pr.merge', { ref: { repo: pr.repo, number: pr.number }, method, conditions: { head } });
  const commit = record(merged?.landed)?.commit;
  if (typeof commit !== 'string') {
    throw new Error(`forge pr.merge applied the merge of ${pr.repo.path}#${String(pr.number)} at ${head} but named no landed commit`);
  }
  return commit;
}
