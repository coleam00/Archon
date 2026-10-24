/**
 * The pack's one issue read, its close, and its create-or-recover by marker, through
 * whichever source the run selected (./forge.ts).
 *
 * Both sources prove the number names an issue on the tracker before anything is
 * returned or written, so a pull request with the same number is never read or
 * closed as the issue.
 * `appendSection` adds a dated section to the body, the one body write the pack makes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgeSource,
  ghApi,
  invokeForge,
  parseQualifiedPr,
  record,
  retryTransient,
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
  return retryTransient(() => (forgeSource() === 'forge' ? forgeView(item) : ghView(item)));
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
  const issue = record(
    JSON.parse(
      ghApi(`gh api issues/${String(item.number)}`, [
        '--hostname',
        item.repo.host,
        `repos/${item.repo.path}/issues/${String(item.number)}`,
      ])
    )
  );
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
 * The marker read is also what makes a repeat after a transient failure safe.
 */
export function createIssue(
  repo: QualifiedPr['repo'],
  title: string,
  body: string,
  marker: string
): CreatedIssue {
  if (firstLine(body) !== marker) throw new Error('the issue body must begin with its marker');
  return retryTransient(() => createIssueOnce(repo, title, body, marker));
}

/** The one issue, open or closed, whose body begins with `marker`, if there is one. */
function ghMarkedIssue(
  repo: QualifiedPr['repo'],
  marker: string
): Record<string, unknown> | undefined {
  // Paged explicitly: `--include` prints each page's headers inside a
  // `--paginate --slurp` array, so gh's own paging cannot carry the status.
  const rows: unknown[] = [];
  for (let page = 1; ; page++) {
    const listed: unknown = JSON.parse(
      ghApi('gh api issue listing', [
        '--hostname',
        repo.host,
        `repos/${repo.path}/issues?state=all&per_page=100&page=${String(page)}`,
      ])
    );
    if (!Array.isArray(listed)) throw new Error('gh api returned an unexpected issue listing');
    rows.push(...listed);
    if (listed.length < 100) break;
  }
  const marked = rows
    .map(record)
    .filter(
      row =>
        row !== undefined &&
        !('pull_request' in row) &&
        typeof row.body === 'string' &&
        firstLine(row.body) === marker
    );
  if (marked.length > 1) throw new Error(`more than one issue carries ${marker}`);
  return marked[0];
}

function createIssueOnce(
  repo: QualifiedPr['repo'],
  title: string,
  body: string,
  marker: string
): CreatedIssue {
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
  const found = ghMarkedIssue(repo, marker);
  if (found !== undefined) {
    if (typeof found.number !== 'number') throw new Error('gh api listed an issue with no number');
    const issue = { repo, number: found.number };
    return { issue, url: ghIssue(issue).html_url };
  }
  const directory = mkdtempSync(join(tmpdir(), 'archon-issue-'));
  let created: string;
  try {
    // The body travels in a request file: argv is not where authored content belongs.
    const payload = join(directory, 'issue.json');
    writeFileSync(payload, JSON.stringify({ title, body }), { mode: 0o600 });
    created = ghApi('gh api issue create', [
      '--hostname',
      repo.host,
      '--method',
      'POST',
      `repos/${repo.path}/issues`,
      '--input',
      payload,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const number = record(JSON.parse(created))?.number;
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
 * forge contract does. That makes a repeat after a transient failure safe.
 */
export function closeIssue(item: QualifiedPr, reason: CloseReason): void {
  retryTransient(() => closeIssueOnce(item, reason));
}

function closeIssueOnce(item: QualifiedPr, reason: CloseReason): void {
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
  ghApi(`gh api close of issue ${String(item.number)}`, [
    '--hostname',
    item.repo.host,
    '--method',
    'PATCH',
    `repos/${item.repo.path}/issues/${String(item.number)}`,
    '-f',
    'state=closed',
    '-f',
    `state_reason=${reason}`,
  ]);
  const after = ghIssue(item);
  if (after.state !== 'closed' || after.state_reason !== reason) {
    throw new Error(`${after.html_url} does not read back closed as ${reason}; it may be closed`);
  }
}

/**
 * Append `## <heading>` and `text` to the issue's body and read it back. A body that
 * already ends with that section is left as it is, so a repeated write adds nothing.
 * Neither source has a conditional body write: an edit someone saves between the read
 * here and the write is lost, and the read-back cannot tell. The section check makes a
 * repeat after a transient failure safe.
 */
export function appendSection(item: QualifiedPr, heading: string, text: string): void {
  retryTransient(() => appendSectionOnce(item, heading, text));
}

function appendSectionOnce(item: QualifiedPr, heading: string, text: string): void {
  const section = `## ${heading}\n\n${text.trim()}\n`;
  if (forgeSource() === 'forge') {
    const body = forgeView(item).body;
    if (body.trimEnd().endsWith(section.trimEnd())) return;
    // `workitem.edit-body` reads its own write back, and a failure throws with its outcome.
    invokeForge('workitem.edit-body', { ref: item, body: `${body.trimEnd()}\n\n\n${section}` });
    return;
  }
  const before = ghIssue(item);
  const body = typeof before.body === 'string' ? before.body : '';
  if (body.trimEnd().endsWith(section.trimEnd())) return;
  const dir = mkdtempSync(join(tmpdir(), 'archon-issue-body-'));
  try {
    const request = join(dir, 'body.json');
    writeFileSync(request, JSON.stringify({ body: `${body.trimEnd()}\n\n\n${section}` }));
    ghApi(`gh api body write of issue ${String(item.number)}`, [
      '--hostname',
      item.repo.host,
      '--method',
      'PATCH',
      `repos/${item.repo.path}/issues/${String(item.number)}`,
      '--input',
      request,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = ghIssue(item);
  if (typeof after.body !== 'string' || !after.body.trimEnd().endsWith(section.trimEnd())) {
    throw new Error(`${after.html_url} does not read back with the section "${heading}"; it may have it`);
  }
}
