/**
 * The pack's one issue read, its close, and its create-or-recover by marker, through
 * whichever source the run selected (./forge.ts).
 *
 * Both sources prove the number names an issue on the tracker before anything is
 * returned or written, so a pull request with the same number is never read or
 * closed as the issue.
 * `issueAtCreation` recovers the text an issue was opened with, from GitHub's edit
 * history; the forge source has no history and answers with the current text.
 * `issueBodyAt` recovers the body at a past moment the same way, and `appendSection`
 * adds a dated section to the body, the one body write the pack makes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgeSource,
  invokeForge,
  parseQualifiedPr,
  record,
  samePr,
  type QualifiedPr,
} from './forge.ts';

export interface IssueView {
  readonly title: string;
  readonly body: string;
  /**
   * The author's login. Null when the forge has none (a deleted account);
   * undefined when the source does not report an author at all.
   */
  readonly author: string | null | undefined;
  readonly labels: readonly string[];
  readonly state: 'open' | 'closed';
  readonly url: string;
}

/** The number names a pull request, which shares the issue numbering. */
export class NotAnIssueError extends Error {
  constructor(where: string) {
    super(`${where} is a pull request, not an issue`);
    this.name = 'NotAnIssueError';
  }
}

export function viewIssue(item: QualifiedPr): IssueView {
  return forgeSource() === 'forge' ? forgeView(item) : ghView(item);
}

function labelNames(values: unknown[]): string[] {
  return values.map(value => {
    const name = typeof value === 'string' ? value : record(value)?.name;
    if (typeof name !== 'string' || name === '') throw new Error('the issue has an invalid label');
    return name;
  });
}

function login(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The issue as `gh api` reports it, after its identity is proved. */
function ghIssue(
  item: QualifiedPr
): Record<string, unknown> & { readonly html_url: string; readonly state: IssueView['state'] } {
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      '--hostname',
      item.repo.host,
      `repos/${item.repo.path}/issues/${String(item.number)}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `gh api issues/${String(item.number)} failed: ${result.stderr.toString().trim()}`
    );
  }
  const issue = record(JSON.parse(result.stdout.toString()));
  const url = `https://${item.repo.host}/${item.repo.path}/issues/${String(item.number)}`;
  if (issue?.number === item.number && 'pull_request' in issue) throw new NotAnIssueError(url);
  if (
    issue?.number !== item.number ||
    typeof issue.html_url !== 'string' ||
    issue.html_url.toLowerCase() !== url.toLowerCase()
  ) {
    throw new Error(`tracker identity mismatch: ${url} does not answer as that issue`);
  }
  if (issue.state !== 'open' && issue.state !== 'closed') {
    throw new Error(`${url} has no open or closed state`);
  }
  return { ...issue, html_url: issue.html_url, state: issue.state };
}

function ghView(item: QualifiedPr): IssueView {
  const issue = ghIssue(item);
  return {
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    author: login(record(issue.user)?.login),
    labels: labelNames(Array.isArray(issue.labels) ? issue.labels : []),
    state: issue.state,
    url: issue.html_url,
  };
}

function forgeView(item: QualifiedPr): IssueView {
  const value = invokeForge('workitem.view', { ref: item });
  const observed = parseQualifiedPr(JSON.stringify(value?.ref));
  if (samePr(item, observed) && value?.kind === 'pr') {
    throw new NotAnIssueError(`${item.repo.host}/${item.repo.path}#${String(item.number)}`);
  }
  if (
    !samePr(item, observed) ||
    value?.kind !== 'issue' ||
    !Array.isArray(value.labels) ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.url !== 'string' ||
    (value.state !== 'open' && value.state !== 'closed')
  ) {
    throw new Error('forge work item has no verified issue identity and label facts');
  }
  return {
    title: value.title,
    body: value.body,
    // Absent: the plugin does not report an author. Null: the forge has none.
    author: value.author === undefined ? undefined : login(record(value.author)?.login),
    labels: labelNames(value.labels),
    state: value.state,
    url: value.url,
  };
}

/** A created or recovered issue, read back from the tracker. */
export interface CreatedIssue {
  readonly issue: QualifiedPr;
  readonly url: string;
}

function firstLine(body: string): string {
  return body.split(/\r?\n/, 1)[0] ?? '';
}

/**
 * Create the one issue whose body begins with `marker`, or recover it when an earlier
 * attempt already created it, so a repeated call never files a second one. Both
 * sources look across every issue, open or closed, and refuse when more than one
 * carries the marker. A recovered issue is returned as it is, never edited or
 * reopened. A new one must read back open with the requested title and body.
 */
export function createIssue(
  repo: QualifiedPr['repo'],
  title: string,
  body: string,
  marker: string
): CreatedIssue {
  if (firstLine(body) !== marker) throw new Error('the issue body must begin with its marker');
  if (forgeSource() === 'forge') {
    const value = invokeForge('workitem.create', { repo, title, body, marker });
    const item = record(value?.workitem);
    const ref = parseQualifiedPr(JSON.stringify(item?.ref));
    if (
      value?.outcome !== 'applied' ||
      item?.kind !== 'issue' ||
      !samePr({ repo, number: ref.number }, ref) ||
      typeof item.url !== 'string'
    ) {
      throw new Error('forge returned no verified created issue');
    }
    return { issue: ref, url: item.url };
  }
  const listed = Bun.spawnSync(
    [
      'gh',
      'api',
      '--hostname',
      repo.host,
      '--paginate',
      '--slurp',
      `repos/${repo.path}/issues?state=all&per_page=100`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (listed.exitCode !== 0) {
    throw new Error(`gh api issue listing failed: ${listed.stderr.toString().trim()}`);
  }
  const pages: unknown = JSON.parse(listed.stdout.toString());
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('gh api returned an unexpected issue listing');
  }
  const marked = (pages as unknown[][])
    .flat()
    .map(record)
    .filter(
      row =>
        row !== undefined &&
        !('pull_request' in row) &&
        typeof row.body === 'string' &&
        firstLine(row.body) === marker
    );
  if (marked.length > 1) throw new Error(`more than one issue carries ${marker}`);
  const found = marked[0];
  if (found !== undefined) {
    if (typeof found.number !== 'number') throw new Error('gh api listed an issue with no number');
    const issue = { repo, number: found.number };
    return { issue, url: ghIssue(issue).html_url };
  }
  const directory = mkdtempSync(join(tmpdir(), 'archon-issue-'));
  let created: { exitCode: number; stdout: Buffer; stderr: Buffer };
  try {
    // The body travels in a request file: argv is not where authored content belongs.
    const payload = join(directory, 'issue.json');
    writeFileSync(payload, JSON.stringify({ title, body }), { mode: 0o600 });
    created = Bun.spawnSync(
      [
        'gh',
        'api',
        '--hostname',
        repo.host,
        '--method',
        'POST',
        `repos/${repo.path}/issues`,
        '--input',
        payload,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (created.exitCode !== 0) {
    throw new Error(`gh api issue create failed: ${created.stderr.toString().trim()}`);
  }
  const number = record(JSON.parse(created.stdout.toString()))?.number;
  if (typeof number !== 'number') {
    throw new Error('gh api returned no issue number; an issue may have been created');
  }
  const issue = { repo, number };
  const observed = ghIssue(issue);
  if (observed.title !== title || observed.body !== body || observed.state !== 'open') {
    throw new Error(`${observed.html_url} does not read back as created`);
  }
  return { issue, url: observed.html_url };
}

/** Why the pack closes an issue: the subset of the forge contract's reasons it uses. */
export const CLOSE_REASONS = ['completed', 'duplicate'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * Close the issue with a reason and read the result back. An issue already closed
 * for that reason is left as it is; one closed for another reason is refused, as the
 * forge contract does.
 */
export function closeIssue(item: QualifiedPr, reason: CloseReason): void {
  if (forgeSource() === 'forge') {
    const value = invokeForge('workitem.close', { ref: item, reason });
    if (record(value?.workitem)?.state !== 'closed' || value?.reason !== reason)
      throw new Error('forge returned no verified close');
    return;
  }
  const before = ghIssue(item);
  if (before.state === 'closed') {
    if (before.state_reason === reason) return;
    throw new Error(`${before.html_url} is already closed for another reason`);
  }
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      '--hostname',
      item.repo.host,
      '--method',
      'PATCH',
      `repos/${item.repo.path}/issues/${String(item.number)}`,
      '-f',
      'state=closed',
      '-f',
      `state_reason=${reason}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `gh api close of issue ${String(item.number)} failed: ${result.stderr.toString().trim()}`
    );
  }
  const after = ghIssue(item);
  if (after.state !== 'closed' || after.state_reason !== reason) {
    throw new Error(`${after.html_url} does not read back closed as ${reason}; it may be closed`);
  }
}

/** `current` when the creation body could not be recovered and the current one stands in. */
export const BODY_SOURCES = ['creation', 'current'] as const;

/** The title and body an issue was opened with, and whether the body really is that. */
export interface IssueAtCreation {
  readonly title: string;
  readonly body: string;
  readonly body_from: (typeof BODY_SOURCES)[number];
}

const CREATION_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) { issue(number: $number) {',
  'createdAt',
  'userContentEdits(last: 1) { totalCount nodes { editedAt diff } }',
  'timelineItems(first: 1, itemTypes: [RENAMED_TITLE_EVENT]) {',
  'nodes { ... on RenamedTitleEvent { previousTitle } } }',
  '} } }',
].join(' ');

export function issueAtCreation(item: QualifiedPr, current: IssueView): IssueAtCreation {
  if (forgeSource() === 'forge') {
    return { title: current.title, body: current.body, body_from: 'current' };
  }
  const history = graphql(item, CREATION_QUERY, `issue ${String(item.number)} history`);
  const edits = record(history?.userContentEdits);
  if (history === undefined || typeof edits?.totalCount !== 'number') {
    throw new Error(`issue ${String(item.number)} has no edit history to read`);
  }
  // Edits are newest first and each holds the whole body at that revision, so the
  // last one is the oldest. It is the creation body when it was made at creation; a
  // deleted revision has no diff, and then the current body stands in, visibly.
  const oldest = record(Array.isArray(edits.nodes) ? edits.nodes[0] : undefined);
  const recovered =
    edits.totalCount === 0
      ? current.body
      : typeof oldest?.diff === 'string' && oldest.editedAt === history.createdAt
        ? oldest.diff
        : undefined;
  const renames = record(history.timelineItems)?.nodes;
  const previousTitle = record(Array.isArray(renames) ? renames[0] : undefined)?.previousTitle;
  return {
    title: typeof previousTitle === 'string' ? previousTitle : current.title,
    body: recovered ?? current.body,
    body_from: recovered === undefined ? 'current' : 'creation',
  };
}

function graphql(item: QualifiedPr, query: string, what: string): Record<string, unknown> | undefined {
  const slash = item.repo.path.indexOf('/');
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      'graphql',
      '--hostname',
      item.repo.host,
      '-f',
      `query=${query}`,
      '-f',
      `owner=${item.repo.path.slice(0, slash)}`,
      '-f',
      `name=${item.repo.path.slice(slash + 1)}`,
      '-F',
      `number=${String(item.number)}`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) {
    throw new Error(`gh api graphql (${what}) failed: ${result.stderr.toString().trim()}`);
  }
  const data = record(record(JSON.parse(result.stdout.toString()))?.data);
  return record(record(data?.repository)?.issue);
}

const EDITS_QUERY = [
  'query($owner: String!, $name: String!, $number: Int!) {',
  'repository(owner: $owner, name: $name) { issue(number: $number) {',
  'createdAt body',
  'userContentEdits(first: 100) { totalCount nodes { editedAt diff } }',
  '} } }',
].join(' ');

/**
 * The issue's body as it was at `at`, from GitHub's edit history. Edits are newest
 * first and each holds the whole body at that revision. A history it cannot read
 * whole, a deleted revision, or a time before the issue existed refuses: a replay must
 * never judge text the issue did not have at that moment.
 */
export function issueBodyAt(item: QualifiedPr, at: string): string {
  if (forgeSource() === 'forge') {
    throw new Error('the forge source has no edit history, so the body at a past time is unknown');
  }
  const when = Date.parse(at);
  if (Number.isNaN(when)) throw new Error(`"${at}" is not a time`);
  const issue = graphql(item, EDITS_QUERY, `issue ${String(item.number)} history`);
  const edits = record(issue?.userContentEdits);
  if (
    typeof issue?.createdAt !== 'string' ||
    typeof issue.body !== 'string' ||
    typeof edits?.totalCount !== 'number' ||
    !Array.isArray(edits.nodes)
  ) {
    throw new Error(`issue ${String(item.number)} has no edit history to read`);
  }
  if (when < Date.parse(issue.createdAt)) throw new Error(`issue ${String(item.number)} did not exist at ${at}`);
  if (edits.totalCount === 0) return issue.body;
  if (edits.totalCount > edits.nodes.length) {
    throw new Error(`issue ${String(item.number)} has more edits than one history read returns`);
  }
  const revision = edits.nodes.map(record).find(
    edit => typeof edit?.editedAt === 'string' && Date.parse(edit.editedAt) <= when
  );
  if (typeof revision?.diff !== 'string') {
    throw new Error(`issue ${String(item.number)} has no readable revision at ${at}`);
  }
  return revision.diff;
}

/**
 * Append `## <heading>` and `text` to the issue's body and read it back. A body that
 * already ends with that section is left as it is, so a repeated write adds nothing.
 * GitHub has no conditional body write: an edit someone saves between the read here
 * and the write is lost, and the read-back cannot tell.
 */
export function appendSection(item: QualifiedPr, heading: string, text: string): void {
  if (forgeSource() === 'forge') {
    throw new Error('the forge contract has no issue body write, so the section cannot be added');
  }
  const section = `## ${heading}\n\n${text.trim()}\n`;
  const before = ghIssue(item);
  const body = typeof before.body === 'string' ? before.body : '';
  if (body.trimEnd().endsWith(section.trimEnd())) return;
  const dir = mkdtempSync(join(tmpdir(), 'archon-issue-body-'));
  try {
    const request = join(dir, 'body.json');
    writeFileSync(request, JSON.stringify({ body: `${body.trimEnd()}\n\n\n${section}` }));
    const result = Bun.spawnSync(
      [
        'gh',
        'api',
        '--hostname',
        item.repo.host,
        '--method',
        'PATCH',
        `repos/${item.repo.path}/issues/${String(item.number)}`,
        '--input',
        request,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `gh api body write of issue ${String(item.number)} failed: ${result.stderr.toString().trim()}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = ghIssue(item);
  if (typeof after.body !== 'string' || !after.body.trimEnd().endsWith(section.trimEnd())) {
    throw new Error(`${after.html_url} does not read back with the section "${heading}"; it may have it`);
  }
}
