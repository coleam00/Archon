/**
 * What a lap of the loop could start right now, read from the board without a model.
 *
 * A scheduler calls this before it starts a lap. A lap that finds nothing to do still
 * costs a pick, a worktree and a database run, and a backlog that is one long chain of
 * dependencies leaves most parallel laps with nothing. This mirrors the pick rules that
 * are facts rather than judgement: an item with a live claim is taken, an item labelled
 * `needs-owner` waits for the owner, an issue waits for its `Depends on:` items, and the
 * issues the manager keeps for itself are not work. Anything it is unsure of counts as
 * workable, so the gate can only skip laps that would have picked nothing.
 */

import { CLAIM_PREFIX } from './claims.ts';

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  /** The comment's web URL; its `#issuecomment-<id>` names the comment to edit. */
  readonly url?: string;
}

export interface BoardItem {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly BoardComment[];
}

export interface Board {
  readonly issues: readonly BoardItem[];
  readonly pulls: readonly BoardItem[];
}

export interface WorkableItem {
  readonly kind: 'issue' | 'pull';
  readonly number: number;
}

export interface LiveClaim {
  readonly kind: 'issue' | 'pull';
  readonly number: number;
  readonly run: string;
}

export interface EndedClaim extends LiveClaim {
  readonly url: string;
}

export interface Workability {
  readonly workable: WorkableItem[];
  readonly claims: LiveClaim[];
  /** Claims whose run the scheduler knows has ended: dead now, and the caller releases them. */
  readonly ended: EndedClaim[];
  readonly waiting: { readonly kind: 'issue' | 'pull'; readonly number: number; readonly why: string }[];
}

/** The label an owner decision carries; the loop never works an item under it. */
export const OWNER_LABEL = 'needs-owner';

/** Issues the manager keeps for its own records. They hold questions and metrics, not work. */
export const MANAGER_TITLES = new Set(['Owner decisions needed', 'Loop metrics']);

/** `Depends on: #12, #14` lines, as pick reads them. */
export function dependencies(body: string): number[] {
  const found: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*\**depends on\**:?\**\s*(.*)$/i.exec(line);
    if (match === null) continue;
    for (const ref of match[1].matchAll(/#(\d+)/g)) found.push(Number(ref[1]));
  }
  return found;
}

/** Issues a pull request says it delivers (`Closes #n`, `Fixes #n`, `Resolves #n`). */
export function closes(body: string): number[] {
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map(m => Number(m[1]));
}

/** Unexpired claim comments on an item, oldest first, with the run each names. */
export function liveClaimComments(
  comments: readonly BoardComment[],
  expiryHours: number,
  now: number
): { run: string; comment: BoardComment }[] {
  const found: { run: string; comment: BoardComment }[] = [];
  for (const comment of comments) {
    if (!comment.body.startsWith(CLAIM_PREFIX)) continue;
    const created = Date.parse(comment.createdAt);
    if (Number.isNaN(created) || now - created > expiryHours * 3_600_000) continue;
    found.push({ run: comment.body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '', comment });
  }
  return found;
}

/**
 * The board as a lap would find it. `endedRuns` are runs the scheduler knows have
 * finished, failed or been cancelled: a run killed before its release step never frees
 * its item, so its claim is treated as dead here and returned in `ended` for release.
 */
export function workability(
  board: Board,
  expiryHours: number,
  now = Date.now(),
  endedRuns: ReadonlySet<string> = new Set()
): Workability {
  const openIssues = new Set(board.issues.map(item => item.number));
  const openPulls = new Set(board.pulls.map(item => item.number));
  const claims: LiveClaim[] = [];
  const ended: EndedClaim[] = [];
  const claimed = new Map<string, string>();
  for (const [kind, items] of [
    ['issue', board.issues],
    ['pull', board.pulls],
  ] as const) {
    for (const item of items) {
      for (const { run, comment } of liveClaimComments(item.comments, expiryHours, now)) {
        if (endedRuns.has(run)) {
          if (comment.url) ended.push({ kind, number: item.number, run, url: comment.url });
          continue;
        }
        if (claimed.has(`${kind}:${item.number}`)) continue;
        claims.push({ kind, number: item.number, run });
        claimed.set(`${kind}:${item.number}`, run);
      }
    }
  }
  // An open pull request is the work for the issues it closes: pick continues the
  // pull request instead of starting the issue, and claims the issue for it.
  const deliveredBy = new Map<number, number>();
  for (const pull of board.pulls) for (const issue of closes(pull.body)) deliveredBy.set(issue, pull.number);

  const workable: WorkableItem[] = [];
  const waiting: Workability['waiting'] = [];
  for (const pull of board.pulls) {
    const linked = closes(pull.body).filter(n => openIssues.has(n));
    const owner = pull.labels.includes(OWNER_LABEL) ||
      linked.some(n => board.issues.find(i => i.number === n)?.labels.includes(OWNER_LABEL));
    const holder = claimed.get(`pull:${pull.number}`) ?? linked.map(n => claimed.get(`issue:${n}`)).find(Boolean);
    if (owner) waiting.push({ kind: 'pull', number: pull.number, why: OWNER_LABEL });
    else if (holder) waiting.push({ kind: 'pull', number: pull.number, why: `claimed by run ${holder}` });
    else workable.push({ kind: 'pull', number: pull.number });
  }
  for (const issue of board.issues) {
    const blockers = dependencies(issue.body).filter(n => openIssues.has(n) || openPulls.has(n));
    const holder = claimed.get(`issue:${issue.number}`);
    let why: string | null = null;
    if (MANAGER_TITLES.has(issue.title.trim())) why = "the manager's own record";
    else if (issue.labels.includes(OWNER_LABEL)) why = OWNER_LABEL;
    else if (deliveredBy.has(issue.number)) why = `delivered by pull request #${deliveredBy.get(issue.number)}`;
    else if (holder) why = `claimed by run ${holder}`;
    else if (blockers.length > 0) why = `depends on ${blockers.map(n => `#${n}`).join(', ')}`;
    if (why === null) workable.push({ kind: 'issue', number: issue.number });
    else waiting.push({ kind: 'issue', number: issue.number, why });
  }
  return { workable, claims, ended, waiting };
}
