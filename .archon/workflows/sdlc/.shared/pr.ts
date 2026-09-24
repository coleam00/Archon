/**
 * The pack's pull-request reads and writes, through whichever source the run
 * selected (./forge.ts).
 *
 * Every write here is performed and then read back before it is reported as
 * applied. On the forge path the plugin owns that verification and reports which
 * of the four outcomes happened; on `gh` this module performs the same read-back
 * and raises the failure itself. Neither path falls back to the other, and an
 * operation whose outcome could not be established is never retried here.
 *
 * Authored content — a pull-request body, a review report — is passed by file
 * path on both paths, so it never reaches any process's argv.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  invokeForge,
  parsePrRecord,
  record,
  sameRepo,
  type ForgeSource,
  type PrRecord,
  type QualifiedPr,
} from './forge.ts';

export interface PrView {
  readonly pr: PrRecord;
  readonly title: string;
  readonly body: string;
}

export interface CreatePrIntent {
  readonly repo: QualifiedPr['repo'];
  readonly headRepo: QualifiedPr['repo'];
  readonly head: string;
  readonly headRevision: string;
  readonly base: string;
  readonly title: string;
  readonly bodyPath: string;
  readonly draft: boolean;
}

interface Ran {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

// Every gh call is captured: a node's stderr reaches the operator, and gh is
// chatty there (update notices), so only this pack's own messages may.
function gh(...args: string[]): Ran {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function ghRepo(repo: QualifiedPr['repo']): string {
  return `${repo.host}/${repo.path}`;
}

function required(result: Ran, what: string): string {
  if (!result.ok) throw new Error(`${what} failed: ${result.stderr}`);
  return result.stdout;
}

const PR_FIELDS = [
  'number',
  'url',
  'title',
  'body',
  'isDraft',
  'state',
  'baseRefName',
  'headRefName',
  'headRefOid',
  'headRepository',
  'headRepositoryOwner',
  'maintainerCanModify',
].join(',');

/** One `gh pr view --json` row, narrowed to the fields this pack consumes. */
function ghPrView(repo: QualifiedPr['repo'], value: unknown): PrView {
  const row = record(value);
  const headRepository = record(row?.headRepository);
  const headOwner = record(row?.headRepositoryOwner);
  const headPath =
    typeof headRepository?.name === 'string' && typeof headOwner?.login === 'string'
      ? `${headOwner.login}/${headRepository.name}`
      : undefined;
  const state = typeof row?.state === 'string' ? row.state.toLowerCase() : '';
  return {
    pr: parsePrRecord({
      schemaVersion: 1,
      repo,
      number: row?.number,
      url: row?.url,
      head: row?.headRefName,
      base: row?.baseRefName,
      is_draft: row?.isDraft,
      state,
      head_repo: headPath === undefined ? null : { host: repo.host, path: headPath },
      head_revision: typeof row?.headRefOid === 'string' && row.headRefOid !== '' ? row.headRefOid : null,
      // gh does not report the base revision; the record keeps that absence explicit.
      base_revision: null,
      maintainer_can_modify:
        typeof row?.maintainerCanModify === 'boolean' ? row.maintainerCanModify : null,
    }),
    title: typeof row?.title === 'string' ? row.title : '',
    body: typeof row?.body === 'string' ? row.body : '',
  };
}

/** A forge operation whose success always carries a result. */
function forgeResult(op: string, request: Record<string, unknown>): Record<string, unknown> {
  const value = invokeForge(op, request);
  if (value === null) throw new Error(`forge ${op} returned no result`);
  return value;
}

function forgePrView(value: Record<string, unknown>): PrView {
  return {
    pr: parsePrRecord(record(value)?.pr),
    title: typeof value.title === 'string' ? value.title : '',
    body: typeof value.body === 'string' ? value.body : '',
  };
}

/**
 * The open pull request whose head is `headRepo:head` in `repo`, or undefined.
 *
 * "Open" is the question every caller here is actually asking: a branch that was
 * delivered and closed months ago must not stop a new pull request from opening,
 * and an open one must never be duplicated. More than one match is refused rather
 * than guessed at.
 */
export function findOpenPrByHead(
  repo: QualifiedPr['repo'],
  headRepo: QualifiedPr['repo'],
  head: string,
  source: ForgeSource
): PrView | undefined {
  if (source === 'forge') {
    const value = invokeForge('pr.view', {
      selector: { kind: 'head', repo, headRepo, head },
    });
    return value === null ? undefined : forgePrView(value);
  }
  const listed = gh(
    'pr',
    'list',
    '--repo',
    ghRepo(repo),
    '--head',
    head,
    '--state',
    'open',
    '--json',
    PR_FIELDS
  );
  const rows: unknown = JSON.parse(required(listed, 'gh pr list'));
  if (!Array.isArray(rows)) throw new Error('gh pr list returned an unexpected payload');
  // gh matches a head branch by name alone, so the qualified head repository is
  // compared here; the forge selector already carries it.
  const matches = rows
    .map(row => ghPrView(repo, row))
    .filter(view => view.pr.head_repo !== null && sameRepo(view.pr.head_repo, headRepo));
  if (matches.length > 1) {
    throw new Error(
      `more than one open pull request in ${repo.path} has head ${headRepo.path}:${head}`
    );
  }
  return matches[0];
}

export function viewPr(ref: QualifiedPr, source: ForgeSource): PrView {
  if (source === 'forge') {
    const value = forgeResult('pr.view', {
      selector: { kind: 'number', ref: { repo: ref.repo, number: ref.number } },
    });
    return forgePrView(value);
  }
  const result = gh(
    'pr',
    'view',
    String(ref.number),
    '--repo',
    ghRepo(ref.repo),
    '--json',
    PR_FIELDS
  );
  return ghPrView(ref.repo, JSON.parse(required(result, `gh pr view ${String(ref.number)}`)));
}

/**
 * Open the pull request and return the record read back from the forge.
 *
 * A create that cannot be found again afterwards is reported as a pull request
 * that may exist, never as a failure that leaves the branch free to try again.
 */
export function createPr(intent: CreatePrIntent, source: ForgeSource): PrRecord {
  if (source === 'forge') {
    const value = forgeResult('pr.create', {
      repo: intent.repo,
      headRepo: intent.headRepo,
      head: intent.head,
      headRevision: intent.headRevision,
      base: intent.base,
      title: intent.title,
      body: readFileSync(intent.bodyPath, 'utf8'),
      draft: intent.draft,
    });
    return parsePrRecord(value.pr);
  }
  const body = readFileSync(intent.bodyPath, 'utf8');
  const sameRepository = intent.headRepo.path === intent.repo.path;
  const head = sameRepository ? intent.head : `${intent.headRepo.path.split('/')[0]}:${intent.head}`;
  const created = gh(
    'pr',
    'create',
    '--repo',
    ghRepo(intent.repo),
    '--base',
    intent.base,
    '--head',
    head,
    '--title',
    intent.title,
    '--body-file',
    intent.bodyPath,
    ...(intent.draft ? ['--draft'] : [])
  );
  if (!created.ok) throw new Error(`gh pr create failed: ${created.stderr}`);
  const view = findOpenPrByHead(intent.repo, intent.headRepo, intent.head, source);
  if (!view) {
    throw new Error(
      `gh pr create reported success but no open pull request has head ${intent.headRepo.path}:${intent.head}; a pull request may exist`
    );
  }
  if (
    view.title !== intent.title ||
    view.body !== body ||
    view.pr.head !== intent.head ||
    view.pr.base !== intent.base ||
    view.pr.head_revision !== intent.headRevision ||
    view.pr.is_draft !== intent.draft ||
    view.pr.state !== 'open'
  ) {
    throw new Error(
      `the created pull request ${view.pr.url} does not match what was requested; it may need reconciling`
    );
  }
  return view.pr;
}

/** Replace the pull request body, and prove the replacement landed. */
export function editPrBody(ref: QualifiedPr, bodyPath: string, source: ForgeSource): PrRecord {
  const body = readFileSync(bodyPath, 'utf8');
  if (source === 'forge') {
    const value = forgeResult('pr.edit-body', {
      ref: { repo: ref.repo, number: ref.number },
      body,
    });
    return parsePrRecord(value.pr);
  }
  const number = String(ref.number);
  const edited = gh('pr', 'edit', number, '--repo', ghRepo(ref.repo), '--body-file', bodyPath);
  if (!edited.ok) throw new Error(`gh pr edit failed: ${edited.stderr}`);
  const after = viewPr(ref, source);
  if (after.body !== body) {
    throw new Error(
      `the pull request body read back from ${after.pr.url} does not match what was written; it may need reconciling`
    );
  }
  return after.pr;
}

/** Take the pull request out of draft, and prove it is no longer a draft. */
export function markPrReady(ref: QualifiedPr, source: ForgeSource): PrRecord {
  if (source === 'forge') {
    const value = forgeResult('pr.ready', { ref: { repo: ref.repo, number: ref.number } });
    return parsePrRecord(value.pr);
  }
  const ready = gh('pr', 'ready', String(ref.number), '--repo', ghRepo(ref.repo));
  if (!ready.ok) throw new Error(`the ready flip failed: ${ready.stderr}`);
  const after = viewPr(ref, source);
  if (after.pr.is_draft || after.pr.state !== 'open') {
    throw new Error(`${after.pr.url} still reports draft after the ready flip`);
  }
  return after.pr;
}

interface GhComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
}

function ghIssueComments(ref: QualifiedPr): GhComment[] {
  const comments: GhComment[] = [];
  // Paged explicitly rather than through `gh api --paginate`, so what this reads
  // does not depend on how gh chooses to join pages of a JSON array.
  for (let page = 1; ; page++) {
    const result = gh(
      'api',
      '--hostname',
      ref.repo.host,
      `repos/${ref.repo.path}/issues/${String(ref.number)}/comments?per_page=100&page=${String(page)}`
    );
    const rows: unknown = JSON.parse(required(result, 'gh api issue comments'));
    if (!Array.isArray(rows)) throw new Error('gh api returned an unexpected comment payload');
    for (const row of rows) {
      const comment = record(row);
      if (
        comment === undefined ||
        (typeof comment.id !== 'number' && typeof comment.id !== 'string') ||
        typeof comment.html_url !== 'string'
      ) {
        throw new Error('gh api returned an unexpected comment payload');
      }
      comments.push({
        id: String(comment.id),
        body: typeof comment.body === 'string' ? comment.body : '',
        url: comment.html_url,
      });
    }
    if (rows.length < 100) return comments;
  }
}

/**
 * Write the one comment carrying `marker` on its first line, creating it if it is
 * not there yet and replacing it in place when it is. More than one marked
 * comment is a conflict: guessing which one is canonical would silently abandon
 * the other.
 */
export function upsertComment(
  ref: QualifiedPr,
  marker: string,
  bodyPath: string,
  source: ForgeSource
): { readonly url: string } {
  const body = readFileSync(bodyPath, 'utf8');
  if (source === 'forge') {
    const value = forgeResult('comment.upsert', {
      ref: { repo: ref.repo, number: ref.number },
      marker,
      body,
    });
    const comment = record(value.comment);
    if (typeof comment?.url !== 'string') throw new Error('forge returned no verified comment');
    return { url: comment.url };
  }
  if ((body.split(/\r?\n/, 1)[0] ?? '') !== marker) {
    throw new Error('the comment body must begin with the exact canonical marker');
  }
  const marked = ghIssueComments(ref).filter(
    comment => (comment.body.split(/\r?\n/, 1)[0] ?? '') === marker
  );
  if (marked.length > 1) {
    throw new Error('more than one comment on this pull request carries the canonical marker');
  }
  const previous = marked[0];
  if (previous?.body === body) return { url: previous.url };
  // gh reads the body from a JSON request file: `-f body=@path` would post the
  // literal string, and argv is not where authored content belongs.
  const directory = mkdtempSync(join(tmpdir(), 'archon-comment-'));
  let written: Ran;
  try {
    const payload = join(directory, 'comment.json');
    writeFileSync(payload, JSON.stringify({ body }), { mode: 0o600 });
    written = gh(
      'api',
      '--hostname',
      ref.repo.host,
      '--method',
      previous ? 'PATCH' : 'POST',
      previous
        ? `repos/${ref.repo.path}/issues/comments/${previous.id}`
        : `repos/${ref.repo.path}/issues/${String(ref.number)}/comments`,
      '--input',
      payload
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (!written.ok) throw new Error(`gh api comment write failed: ${written.stderr}`);
  const id = record(JSON.parse(written.stdout))?.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new Error('gh api returned no comment identity; a comment may have changed');
  }
  const observed = ghIssueComments(ref).find(comment => comment.id === String(id));
  if (observed?.body !== body) {
    throw new Error(
      `comment ${String(id)} does not read back as written; it may need reconciling`
    );
  }
  return { url: observed.url };
}
