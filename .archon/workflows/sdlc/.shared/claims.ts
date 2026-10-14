/**
 * Work-item claims: how several runs of one loop share a backlog without two of them
 * working the same item.
 *
 * A claim is a comment on the work item (an issue, or a pull request when no issue is
 * involved) whose body starts with `Loop claim: run <id>`. GitHub numbers comments in
 * the order it stores them, so among the live claims on one item the lowest comment id
 * was first, and it holds the item. That is the whole protocol: no lock service, no
 * scheduler, and a race between two runs that claimed in the same second still has
 * exactly one winner, because each reads the item back after its own claim landed.
 *
 * A claim is live until its run edits it to `Loop claim released` (or `withdrawn`), or
 * until it is older than the expiry: a run that died without releasing must not hold an
 * item forever.
 */

type JsonObject = Record<string, unknown>;

export const CLAIM_PREFIX = 'Loop claim: run ';

export interface WorkItem {
  readonly repository: string;
  readonly number: number;
}

export interface Claim {
  readonly id: number;
  readonly run: string;
  readonly createdAt: number;
}

/** An issue or pull request URL on github.com. */
export function workItem(url: string): WorkItem {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?$/.exec(
    url.trim()
  );
  if (match === null) throw new Error(`not a GitHub issue or pull request URL: '${url}'`);
  return { repository: match[1], number: Number(match[2]) };
}

export function runGh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', 'api', '--hostname', 'github.com', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${args[0] ?? ''} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  const output = result.stdout.toString().trim();
  return output === '' ? null : (JSON.parse(output) as unknown);
}

/** Every comment on the item, oldest first. */
export function comments(item: WorkItem): JsonObject[] {
  const pages = runGh([
    `repos/${item.repository}/issues/${item.number}/comments?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  if (!Array.isArray(pages)) throw new Error('comment listing is malformed');
  return (pages as unknown[])
    .flatMap((page): unknown[] => (Array.isArray(page) ? (page as unknown[]) : [page]))
    .filter((value): value is JsonObject => value !== null && typeof value === 'object');
}

/** Live claims on the item, oldest (lowest id) first. */
export function liveClaims(item: WorkItem, expiryHours: number, now = Date.now()): Claim[] {
  const claims: Claim[] = [];
  for (const comment of comments(item)) {
    const body = typeof comment.body === 'string' ? comment.body : '';
    if (!body.startsWith(CLAIM_PREFIX) || typeof comment.id !== 'number') continue;
    const createdAt = Date.parse(String(comment.created_at));
    if (Number.isNaN(createdAt) || now - createdAt > expiryHours * 3_600_000) continue;
    const run = body.slice(CLAIM_PREFIX.length).split(/\s/, 1)[0] ?? '';
    claims.push({ id: comment.id, run, createdAt });
  }
  return claims.sort((left, right) => left.id - right.id);
}

export function postComment(item: WorkItem, body: string): number {
  const created = runGh([
    `repos/${item.repository}/issues/${item.number}/comments`,
    '--method',
    'POST',
    '-f',
    `body=${body}`,
  ]) as JsonObject | null;
  if (created === null || typeof created.id !== 'number') throw new Error('the claim comment was not created');
  return created.id;
}

export function editComment(item: WorkItem, id: number, body: string): void {
  runGh([`repos/${item.repository}/issues/comments/${id}`, '--method', 'PATCH', '-f', `body=${body}`]);
}

export function expiryHours(value: string): number {
  const hours = Number(value.trim() === '' ? '6' : value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`claim expiry must be a positive number of hours, got '${value}'`);
  return hours;
}
