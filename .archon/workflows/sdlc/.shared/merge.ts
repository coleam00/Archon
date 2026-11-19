/**
 * The merge stage's record on an item's work item, `facts.merge`, and the pull-request
 * facts its gate reads before every merge.
 *
 * The merge stage takes the items the build queue finished: a work item whose
 * `facts.build` is `ready`. Its pull request is the latest one a build round recorded,
 * or, when none did, the one triage routed the item to continue. A merge run is on the
 * issue's item, where the engine admits one at a time, so it takes no claim.
 *
 * Every read and the merge go through the forge contract (`forge` of `archon:script`).
 */

import { buildWaits, itemPullRequest, type Validation } from './build.ts';
import { type QualifiedPr } from './identity.ts';
import { record } from './inputs.ts';
import { OUTPUT_ENUMS } from './outputs.generated.ts';
import { forge } from 'archon:script';
import { viewPr } from './pr.ts';
import { type DecisionEntry, withDecision } from './queue.ts';
import { type ContractCoverage, type ReviewStamp, readReviewStamp } from './review-comment.ts';
import { itemKey, type WorkItem } from './workitem.ts';

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
 * `waiting`: the next merge run decides it. `asking`: its ask is open on the item.
 * `merged`: this PR merged; a later build may ready another. `returned`: handed back
 * to the build queue, which owns it until it is ready again. `parked`: the stage
 * stopped working it until renewed build readiness.
 */
export type MergeStatus = 'waiting' | 'asking' | 'merged' | 'returned' | 'parked';

/**
 * One merge decision. `head` is the commit it was about, null when the stage settled
 * the item without reading one; `reran` says the stage re-ran its failed checks at that
 * head, which it does at most once per head.
 */
export interface MergeDecisionEntry extends DecisionEntry {
  readonly head: string | null;
  readonly reran: boolean;
}

export interface MergeRecord {
  readonly status: MergeStatus;
  readonly pr: QualifiedPr | null;
  /** A maintainer's approval to merge, pinned to the head they approved. */
  readonly approval: { readonly head: string; readonly at: string } | null;
  readonly decisions: readonly MergeDecisionEntry[];
  /** When the stage last decided the item. */
  readonly at: string;
}

/**
 * Whether the item is the merge stage's to decide. Renewed build readiness waits again
 * after settlement. An item the build queue would accept for another round is refused
 * here: nothing else keeps a merge run off an item a re-triage handed back to the build.
 */
export function mergeWaits(doc: WorkItem): boolean {
  const build = doc.facts.build;
  if (build?.status !== 'ready' || buildWaits(doc)) return false;
  const merge = doc.facts.merge;
  if (merge === undefined || merge.status === 'waiting' || merge.status === 'asking') return true;
  return build.at > merge.at;
}

/**
 * The issue whose item a merge run is on. `itemKey` owns the key's form: a key it does
 * not produce for the number read from it is not an issue's item, and is refused.
 */
export function issueOfItem(key: string | undefined): number {
  const number = Number(key?.split('-').at(-1));
  if (key === undefined || !Number.isInteger(number) || itemKey(number) !== key) {
    throw new Error(`the run is on ${key === undefined ? 'no item' : `item ${key}`}; a merge run is on the item of its issue`);
  }
  return number;
}

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
    facts: { ...doc.facts, merge },
    links: { runs: [...doc.links.runs.filter(id => id !== change.run_id), change.run_id].slice(-50) },
  };
}

/** The ids an ask's options take, as the judge's `output_format` declares them. */
export const ASK_OPTIONS = OUTPUT_ENUMS['archon-merge-queue'].judge['decision.anyOf[2].ask.options[].id'];

/**
 * A maintainer's answer to the stage's ask, as the run it started reads it. `merge`
 * approves the pull request at `head`, the head that was asked about. `return` sends it
 * back to the build queue from `brief`. `park` stops work on it.
 */
export interface MergeAnswer {
  readonly effect: (typeof ASK_OPTIONS)[number];
  /** The id of the option chosen; `other` for an answer that chose none of the three. */
  readonly choice: string;
  /** What the ask said the chosen option does; empty for `other`. */
  readonly does: string;
  readonly text: string;
  readonly at: string;
  readonly head: string;
  readonly brief: string;
}

/**
 * What the facts node hands the judge and the settle node. `settle`: nothing to judge,
 * and `settled` says how the item ends. `wait`: a check woke the run and what it waited
 * for is still not there. `judge`: the agent decides from the snapshot.
 */
export interface MergeStart {
  readonly path: 'settle' | 'wait' | 'judge';
  /** The issue whose item the run is on. */
  readonly item: QualifiedPr;
  readonly pr: QualifiedPr | null;
  readonly url: string;
  readonly facts: PrFacts | null;
  readonly base: BaseFacts | null;
  /** The stage's record, holding an approval the answer just gave. */
  readonly record: Partial<MergeRecord> | null;
  /** The latest validation the item's build rounds recorded, which the gate trusts under `ci: none`. */
  readonly validation: Validation | null;
  /** The changed paths the `protected_paths` setting matches; with any, the gate needs an approval at the head. */
  readonly protected: readonly string[];
  readonly lane: (typeof LANES)[number];
  readonly ci: CiMode;
  readonly answer: MergeAnswer | null;
  readonly settled: { readonly status: Extract<MergeStatus, 'merged' | 'returned' | 'parked'>; readonly reason: string } | null;
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

export interface BaseFacts {
  readonly branch: string;
  readonly head: string;
  readonly checks: Checks;
}

/** A wait as the engine opens it on the item (`returns.waits`). */
export interface EventWait {
  readonly event: 'checks' | 'base-checks';
  readonly about: string;
  readonly within_minutes: number;
}

// Past this the engine lists the item as overdue and the backstop reads it again.
const WAIT_MINUTES = 60;

/**
 * The forge events a pull request that did not merge waits for; `.pack/pack.yaml` binds
 * each name to a completed check. `checks`: a check completing at exactly the pull
 * request's head, while its checks are pending there or the stage just re-ran them.
 * `base-checks`: a check completing at exactly the default branch's head, while that
 * branch is red. A check at any other commit meets neither. Anything else a pull request
 * waits for has no event, and the backstop reads it.
 */
export function eventWaits(facts: PrFacts, base: BaseFacts, ci: CiMode, reran: boolean): EventWait[] {
  const waits: EventWait[] = [];
  if (ci === 'forge' && (facts.checks.state === 'pending' || reran)) {
    waits.push({ event: 'checks', about: facts.head_revision, within_minutes: WAIT_MINUTES });
  }
  if (base.checks.state === 'red') waits.push({ event: 'base-checks', about: base.head, within_minutes: WAIT_MINUTES });
  return waits;
}

/** The default branch, its head commit and the checks on it. */
export function readBase(repo: QualifiedPr['repo']): BaseFacts {
  const value = forge('checks.commit', { repo, at: { kind: 'default_branch' } });
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
 * The trusted review comments: each marked comment a listed maintainer wrote. A
 * marked comment anyone else wrote is ignored, so an outside commenter cannot forge a
 * verdict on a public repository. More than one means none is canonical.
 */
function trustedReviews(comments: readonly Comment[], maintainers: ReadonlySet<string>) {
  return comments.flatMap(comment => {
    const stamp = readReviewStamp(comment.body);
    const trusted = comment.author !== null && maintainers.has(comment.author.toLowerCase());
    return stamp !== null && trusted ? [{ stamp, url: comment.url }] : [];
  });
}

function trustedReview(comments: readonly Comment[], maintainers: ReadonlySet<string>): Verdict {
  const [review, ...others] = trustedReviews(comments, maintainers);
  if (review === undefined) return { state: 'none', reviewed: null, url: null, contract: null };
  if (others.length > 0) return { state: 'duplicate', reviewed: null, url: null, contract: null };
  const state = review.stamp.ready === null ? 'unstamped' : review.stamp.ready ? 'ready' : 'not_ready';
  return { state, reviewed: review.stamp.reviewed, url: review.url, contract: review.stamp.contract };
}

/** The pull request's trusted review comment as stamped, with its report, or null when it has none. */
export function publishedReview(pr: QualifiedPr, maintainers: ReadonlySet<string>): ReviewStamp | null {
  const [review, ...others] = trustedReviews(readComments(pr), maintainers);
  if (others.length > 0) throw new Error(`pull request ${String(pr.number)} has more than one trusted review comment`);
  return review?.stamp ?? null;
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
  const value = forge('pr.merge-state', { ref });
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
  const threads = forge('pr.threads', { ref })?.threads;
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
  const comments = forge('workitem.comments', { subject: { kind: 'pr', ref } })?.comments;
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
 * One snapshot of everything the gate and the judge read about a pull request. Each
 * read that names a commit must name the head.
 */
export function readPr(pr: QualifiedPr, maintainers: ReadonlySet<string>): PrFacts {
  const ref = { repo: pr.repo, number: pr.number };
  const view = viewPr(ref);
  const { url, head_revision: head } = view.pr;
  if (head === null) throw new Error(`${url} reports no head commit`);
  const mergeState = readMergeState(ref, url, head);
  const checks = forge('checks.state', { ref });
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
 * Why the pull request may not merge at `head`; empty when it may. It needs a Ready
 * verdict given at the head and what the project's `ci` setting trusts there, on a
 * default branch whose CI is not red: green forge checks under `forge`, a passing
 * validation delivery recorded at that same head under `none`. The stage never pushes,
 * so a verdict for another commit means someone else pushed after the review. Pending CI
 * on the default branch does not hold a merge. Whether an open review thread holds the
 * merge is the judge's call, from the thread facts it reads. Under the manual lane, or
 * with a protected path changed, a maintainer's approval at `head` is required. The rest
 * keep the merge on an open, non-draft pull request into the default branch at exactly
 * the commit that was judged, and that commit either containing the default branch's
 * head or merging into it with no conflict.
 */
export function gateRefusals(
  facts: PrFacts,
  head: string,
  base: { readonly head: string; readonly checks: Checks },
  ci: CiTrust,
  lane: Lane
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
  if (lane.approved !== head) {
    if (lane.manual) refusals.push('the merge lane is manual and no maintainer approved it at this head');
    else if (lane.protected.length > 0) {
      refusals.push(`it changes protected paths (${lane.protected.join(', ')}) and no maintainer approved it at this head`);
    }
  }
  return refusals;
}

/**
 * What decides whether a pull request may merge without a person: the `merge_lane`
 * setting, the changed paths the `protected_paths` setting matches, and the head a
 * maintainer approved, null when none did.
 */
export interface Lane {
  readonly manual: boolean;
  readonly protected: readonly string[];
  readonly approved: string | null;
}

/** The pack's lane settings; `.pack/pack.yaml` declares the same values. */
export const LANES = ['auto', 'manual'] as const;

/** A lane setting as a run reads it; anything else refuses. */
export function parseLane(name: string, value: string): (typeof LANES)[number] {
  const lane = LANES.find(candidate => candidate === value);
  if (lane === undefined) throw new Error(`the ${name} setting must be one of ${LANES.join(', ')}, not "${value}"`);
  return lane;
}

/** A `list` setting's items. */
export function listSetting(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(item => item !== '');
}

/**
 * The paths the pull request changes that a `protected_paths` glob matches; reads nothing
 * when none is set. With `head`, the commit a gate is about to merge, a file list read at
 * any other commit throws: it would say nothing about what merges.
 */
export function protectedChanges(pr: QualifiedPr, globs: readonly string[], head?: string): string[] {
  if (globs.length === 0) return [];
  const listed = forge('pr.files', { ref: { repo: pr.repo, number: pr.number } });
  const files = listed?.files;
  if (!Array.isArray(files)) throw new Error('forge pr.files returned no file list');
  if (head !== undefined && listed?.head_revision !== head) {
    throw new Error(`its changed files were read at ${String(listed?.head_revision)}, not ${head}`);
  }
  const matchers = globs.map(glob => new Bun.Glob(glob));
  const paths = files.flatMap(file => [record(file)?.path, record(file)?.previous_path]).filter(path => typeof path === 'string');
  return [...new Set(paths)].filter(path => matchers.some(matcher => matcher.match(path)));
}

/**
 * Merge at exactly `head`; the forge refuses when the head has moved since it was read.
 * An applied merge was read back by the forge, which returns the commit it landed as.
 * A merge the plugin cannot verify throws its outcome, which fails the gate, and so does
 * an applied one that names no landed commit: the contract allows a null commit, and
 * nothing then shows the merge landed.
 */
export function mergeAtHead(pr: QualifiedPr, head: string, method: MergeMethod): string {
  const merged = forge('pr.merge', { ref: { repo: pr.repo, number: pr.number }, method, conditions: { head } });
  const commit = record(merged?.landed)?.commit;
  if (typeof commit !== 'string') {
    throw new Error(`forge pr.merge applied the merge of ${pr.repo.path}#${String(pr.number)} at ${head} but named no landed commit`);
  }
  return commit;
}
