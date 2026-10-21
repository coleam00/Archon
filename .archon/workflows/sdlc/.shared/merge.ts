/**
 * The merge queue's record on an item's work item, `facts.merge`, and the pull-request
 * facts its gate reads before every merge.
 *
 * The merge queue takes the items the build queue finished: a work item whose
 * `facts.build` is `ready` names its pull request in its last round. The queue claims
 * them with intake's claim, so an item has one owner at a time across the three queues.
 *
 * Every forge read here goes through the GitHub CLI. The forge contract has no read yet
 * for the trusted review comment, the default branch's head and CI, or how far a head
 * is behind it, and the gate cannot be answered without them, so the merge queue
 * refuses the forge source instead of gating on less.
 */

import { forgeSource, record, type QualifiedPr } from './forge.ts';
import { nullableJson } from './io.ts';
import { isOwnPr } from './own-prs.ts';
import { ghGraphql, ghIssueComments } from './pr.ts';
import type { Attention, DecisionEntry } from './queue.ts';
import { readReviewStamp } from './review-comment.ts';
import type { Pickup, WorkItem } from './workitem.ts';

/** What a merge choice does when a person picks it; archon-merge-queue.yaml declares the same enum. */
export const MERGE_EFFECTS = ['merge', 'return', 'park'] as const;
export type MergeEffect = (typeof MERGE_EFFECTS)[number];
export type MergeAttention = Attention<MergeEffect>;

/** The one answer to a red default branch: the queue holds merges until it is green again. */
export const BASE_EFFECTS = ['hold'] as const;
export type BaseAttention = Attention<(typeof BASE_EFFECTS)[number]>;

/** The sweep's decision on one pull request; archon-merge-queue.yaml declares the same enums. */
export const SWEEP_ACTIONS = ['merged', 'return', 'ask', 'wait'] as const;
export type SweepAction = (typeof SWEEP_ACTIONS)[number];
export const POLICY_CLASSES = ['clear', 'unclear'] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];
export interface Decision {
  readonly number: number;
  readonly action: SweepAction;
  readonly class: PolicyClass;
  readonly head: string;
  readonly reran: boolean;
  readonly reason: string;
  readonly brief: string;
  readonly attention: MergeAttention | null;
}

export interface Sweep {
  readonly decisions: readonly Decision[];
  readonly base: {
    readonly summary: string;
    /** The sweep re-ran the default branch's failed jobs this run. */
    readonly reran: boolean;
    readonly attention: BaseAttention | null;
  };
  readonly summary: string;
}

/** Reads the engine-validated sweep output, or null when the sweep was skipped. */
export function readSweep(value: string | undefined): Sweep | null {
  return nullableJson(value) as Sweep | null;
}

export const MERGE_PATHS = ['idle', 'record', 'sweep'] as const;
export type MergePath = (typeof MERGE_PATHS)[number];
/** Which attention item a run raised: its class label, which the YAML also declares. */
export const MERGE_ASKED_BY = ['pr', 'base'] as const;
export type MergeAskedBy = (typeof MERGE_ASKED_BY)[number];
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
export type MergeMethod = (typeof MERGE_METHODS)[number];

/**
 * `waiting`: the next sweep decides it. `asking`: a run is paused on its attention item.
 * `merged`: this PR merged; a later build may ready another. `returned`: handed back
 * to the build queue, which owns it until it is ready again. `parked`: the queue
 * stopped working it until renewed build readiness
 * or, for an answered own-PR park, a changed head.
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

const KEPT_DECISIONS = 20;
const KEPT_TEXT = 1500;

export function answeredMergeDecision(effect: MergeEffect): `answered: ${MergeEffect}` {
  return `answered: ${effect}`;
}

/** The head of the latest answered own-PR park, when changed-head recovery applies. */
export function answeredOwnPrParkHead(doc: WorkItem): string | null {
  if (!isOwnPr(doc) || doc.facts.merge?.status !== 'parked') return null;
  const last = doc.facts.merge.decisions.at(-1);
  return last?.decision === answeredMergeDecision('park') && last.answer !== undefined ? last.head : null;
}

/**
 * Renewed build readiness waits again after settlement. An answered own-PR park
 * waits only at a different head; an abandoned ask waits once its claim is released.
 */
export function mergeWaits(doc: WorkItem, currentHead?: string): boolean {
  const merge = doc.facts.merge;
  if (isOwnPr(doc)) {
    if (merge === undefined || merge.status === 'waiting' || merge.status === 'asking') return true;
    const parkedHead = answeredOwnPrParkHead(doc);
    return parkedHead !== null && currentHead !== undefined && currentHead !== parkedHead;
  }
  const build = doc.facts.build;
  const readyAt = build?.status === 'ready' ? build.at : doc.facts.own_pr?.at;
  if (readyAt === undefined) return false;
  if (merge === undefined || merge.status === 'waiting' || merge.status === 'asking') return true;
  return readyAt > merge.at;
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

/** The pull request the build queue's last round delivered on the item, or the enrolled own pull request, or null. */
export function itemPr(doc: WorkItem): QualifiedPr | null {
  const url =
    [...(doc.facts.build?.rounds ?? [])].reverse().find(round => round.pr_url !== '')?.pr_url ?? doc.facts.own_pr?.url;
  return url === undefined ? null : prFromUrl(url);
}

/** `https://<host>/<owner>/<name>/pull/<number>`; anything else refuses. */
export function prFromUrl(url: string): QualifiedPr {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a pull request URL`);
  }
  const [owner, name, kind, number, ...rest] = parsed.pathname.split('/').filter(part => part !== '');
  const value = Number(number);
  if (owner === undefined || name === undefined || kind !== 'pull' || rest.length > 0 || !Number.isInteger(value) || value <= 0) {
    throw new Error(`"${url}" is not a pull request URL`);
  }
  return { repo: { host: parsed.host, path: `${owner}/${name}` }, number: value };
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
  const reason = change.entry.reason;
  const merge: MergeRecord = {
    status: change.status,
    pr: change.pr,
    approval: change.approval === undefined ? (prior?.approval ?? null) : change.approval,
    decisions: [
      ...(prior?.decisions ?? []),
      { ...change.entry, reason: reason.length <= KEPT_TEXT ? reason : `${reason.slice(0, KEPT_TEXT)}…` },
    ].slice(-KEPT_DECISIONS),
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
}

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
  readonly mergeable: 'clean' | 'conflict' | 'unknown';
  readonly checks: Checks;
  readonly threads: { readonly unresolved: number; readonly urls: readonly string[] };
  readonly verdict: Verdict;
}

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function graphql(host: string, query: string, fields: Record<string, string | number>): Record<string, unknown> {
  const repository = record(ghGraphql(host, query, fields).repository);
  if (repository === undefined) throw new Error('gh api graphql returned no repository');
  return repository;
}

/**
 * The merge queue reads the forge through gh. The forge contract has no read yet for
 * the trusted review comment, the default branch's head and CI, or how far a head is
 * behind it, so the forge source cannot answer the gate.
 */
export function requireGh(): void {
  if (forgeSource() !== 'gh') {
    throw new Error(
      "the merge queue reads pull-request comments, the default branch's CI and how far a head is behind it, which the forge contract does not offer yet; run it with ARCHON_SDLC_FORGE=gh"
    );
  }
}

const ROLLUP = `statusCheckRollup { contexts(first: 100) { totalCount nodes {
  __typename
  ... on CheckRun { name status conclusion }
  ... on StatusContext { context state }
} } }`;

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Every check context on one commit, as the forge reports its machine states. */
export function checksOf(rollup: unknown): Checks {
  const contexts = record(record(rollup)?.contexts);
  const nodes = Array.isArray(contexts?.nodes) ? contexts.nodes : [];
  if (typeof contexts?.totalCount === 'number' && contexts.totalCount > nodes.length) {
    throw new Error(`the commit has ${String(contexts.totalCount)} checks; the gate reads at most 100`);
  }
  const failing: string[] = [];
  const pending: string[] = [];
  for (const node of nodes) {
    const check = record(node);
    if (check?.__typename === 'CheckRun') {
      const name = String(check.name);
      if (check.status !== 'COMPLETED') pending.push(name);
      else if (!PASSED.has(String(check.conclusion))) failing.push(name);
    } else if (check?.__typename === 'StatusContext') {
      const name = String(check.context);
      if (check.state === 'PENDING' || check.state === 'EXPECTED') pending.push(name);
      else if (check.state !== 'SUCCESS') failing.push(name);
    }
  }
  const state = failing.length > 0 ? 'red' : pending.length > 0 ? 'pending' : nodes.length === 0 ? 'none' : 'green';
  return { state, failing, pending };
}

/** The default branch, its head commit and the checks on it. */
export function readBase(repo: QualifiedPr['repo']): { branch: string; head: string; checks: Checks } {
  const [owner, name] = repo.path.split('/');
  const repository = graphql(
    repo.host,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
      defaultBranchRef { name target { ... on Commit { oid ${ROLLUP} } } }
    } }`,
    { owner: owner ?? '', name: name ?? '' }
  );
  const ref = record(repository.defaultBranchRef);
  const target = record(ref?.target);
  if (typeof ref?.name !== 'string' || typeof target?.oid !== 'string') {
    throw new Error(`${repo.path} reports no default branch`);
  }
  return { branch: ref.name, head: target.oid, checks: checksOf(target.statusCheckRollup) };
}

/**
 * The trusted review comment: the one marked comment a listed maintainer wrote. A
 * marked comment anyone else wrote is ignored, so an outside commenter cannot forge a
 * verdict on a public repository.
 */
function trustedReview(pr: QualifiedPr, maintainers: ReadonlySet<string>): Verdict {
  const reviews = ghIssueComments(pr).flatMap(comment => {
    const stamp = readReviewStamp(comment.body);
    const trusted = comment.author !== null && maintainers.has(comment.author.toLowerCase());
    return stamp !== null && trusted ? [{ stamp, url: comment.url }] : [];
  });
  const [review, ...others] = reviews;
  if (review === undefined) return { state: 'none', reviewed: null, url: null };
  if (others.length > 0) return { state: 'duplicate', reviewed: null, url: null };
  const state = review.stamp.ready === null ? 'unstamped' : review.stamp.ready ? 'ready' : 'not_ready';
  return { state, reviewed: review.stamp.reviewed, url: review.url };
}

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { name }
  pullRequest(number: $number) {
    url title state isDraft baseRefName headRefName headRefOid mergeable
    mergeCommit { oid }
    commits(last: 1) { nodes { commit { oid ${ROLLUP} } } }
    reviewThreads(first: 100) { totalCount nodes { isResolved comments(first: 1) { nodes { url } } } }
  }
} }`;

const BEHIND_QUERY = `query($owner: String!, $name: String!, $head: String!) { repository(owner: $owner, name: $name) {
  defaultBranchRef { target { oid } compare(headRef: $head) { behindBy } }
} }`;

/**
 * The default branch's head and how many of its commits `head` lacks. A head that
 * lacks some still merges when the forge reports it merges cleanly.
 */
function readBehind(repo: QualifiedPr['repo'], head: string): { default_head: string; behind: number } {
  const [owner, name] = repo.path.split('/');
  const ref = record(graphql(repo.host, BEHIND_QUERY, { owner: owner ?? '', name: name ?? '', head }).defaultBranchRef);
  const oid = record(ref?.target)?.oid;
  const behind = record(ref?.compare)?.behindBy;
  if (typeof oid !== 'string' || typeof behind !== 'number') {
    throw new Error(`${repo.path} cannot compare ${head} with its default branch`);
  }
  return { default_head: oid, behind };
}

/** One snapshot of everything the gate and the sweep read about a pull request. */
export function readPr(pr: QualifiedPr, maintainers: ReadonlySet<string>): PrFacts {
  const [owner, name] = pr.repo.path.split('/');
  const repository = graphql(pr.repo.host, PR_QUERY, { owner: owner ?? '', name: name ?? '', number: pr.number });
  const row = record(repository.pullRequest);
  const defaultBranch = record(repository.defaultBranchRef)?.name;
  if (row === undefined || typeof row.headRefOid !== 'string' || typeof defaultBranch !== 'string') {
    throw new Error(`${pr.repo.path} has no pull request ${String(pr.number)}`);
  }
  const commit = record(record((record(row.commits)?.nodes as unknown[] | undefined)?.[0])?.commit);
  if (commit?.oid !== row.headRefOid) throw new Error(`the checks read for ${String(row.url)} are not on its head`);
  const threads = record(row.reviewThreads);
  const threadNodes = Array.isArray(threads?.nodes) ? threads.nodes.map(node => record(node)) : [];
  if (typeof threads?.totalCount === 'number' && threads.totalCount > threadNodes.length) {
    throw new Error(`${String(row.url)} has ${String(threads.totalCount)} review threads; the gate reads at most 100`);
  }
  const unresolved = threadNodes.filter(thread => thread?.isResolved !== true);
  const verdict = trustedReview(pr, maintainers);
  const { default_head, behind } = readBehind(pr.repo, row.headRefOid);
  const state = String(row.state).toLowerCase();
  return {
    pr,
    url: String(row.url),
    title: String(row.title),
    state: state === 'merged' || state === 'closed' ? state : 'open',
    is_draft: row.isDraft === true,
    base: String(row.baseRefName),
    default_branch: defaultBranch,
    default_head,
    behind,
    head: String(row.headRefName),
    head_revision: row.headRefOid,
    merge_commit: typeof record(row.mergeCommit)?.oid === 'string' ? String(record(row.mergeCommit)?.oid) : null,
    mergeable: row.mergeable === 'MERGEABLE' ? 'clean' : row.mergeable === 'CONFLICTING' ? 'conflict' : 'unknown',
    checks: checksOf(commit.statusCheckRollup),
    threads: {
      unresolved: unresolved.length,
      urls: unresolved.map(thread => String(record((record(thread?.comments)?.nodes as unknown[] | undefined)?.[0])?.url ?? '')),
    },
    verdict,
  };
}

/**
 * Why the pull request may not merge at `head`; empty when it may. The facts the
 * queue's contract names are a Ready verdict given at the head and green CI there, on a
 * default branch whose CI is not red. The queue never pushes, so a verdict for another
 * commit means someone else pushed after the review. Pending CI on the default branch
 * does not hold a merge: the next sweep reads its result. Whether an open review thread
 * holds the merge is the sweep's judgment, from the thread facts it reads. The rest keep
 * the merge on an open, non-draft pull request into the default branch at exactly the
 * commit that was judged, and that commit either containing the default branch's head
 * or merging into it with no conflict.
 */
export function gateRefusals(facts: PrFacts, head: string, base: { readonly head: string; readonly checks: Checks }): string[] {
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
  if (facts.checks.state !== 'green') {
    const named = [...facts.checks.failing, ...facts.checks.pending];
    refusals.push(`CI at its head is ${facts.checks.state}${named.length === 0 ? '' : ` (${named.join(', ')})`}`);
  }
  if (base.checks.state === 'red') {
    refusals.push(`the default branch ${facts.default_branch} is red at ${base.head} (${base.checks.failing.join(', ')})`);
  }
  return refusals;
}

/** Merge at exactly `head`; the forge refuses when the head has moved since it was read. */
export function mergeAtHead(pr: QualifiedPr, head: string, method: MergeMethod): void {
  gh('pr', 'merge', String(pr.number), '--repo', `${pr.repo.host}/${pr.repo.path}`, `--${method}`, '--match-head-commit', head);
}

/** The merge commit of a pull request that reads back merged at `head`; null otherwise. */
export function mergeCommitAt(facts: PrFacts, head: string): string | null {
  return facts.state === 'merged' && facts.head_revision === head ? facts.merge_commit : null;
}
