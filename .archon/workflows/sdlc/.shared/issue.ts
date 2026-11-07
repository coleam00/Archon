/**
 * The pack's one issue read, its close, and its create-or-recover by marker, through
 * the forge contract (./forge.ts).
 *
 * The forge proves the number names an issue on the tracker before anything is
 * returned or written, so a pull request with the same number is never read or
 * closed as the issue.
 * `appendSection` adds a dated section to the body, the one body write the pack makes.
 */

import { invokeForge, parseQualifiedPr, record, samePr, type QualifiedPr } from './forge.ts';

export interface IssueView {
  readonly title: string;
  readonly body: string;
  /**
   * The author's login. Null when the forge has none (a deleted account);
   * undefined when the plugin does not report an author at all.
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

export function viewIssue(item: QualifiedPr): IssueView {
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
 * attempt already created it, so a repeated call never files a second one. The
 * forge looks across every issue, open or closed, and refuse when more than one
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

/** Why the pack closes an issue: the subset of the forge contract's reasons it uses. */
export const CLOSE_REASONS = ['completed', 'duplicate'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * Close the issue with a reason and read the result back. An issue already closed
 * for that reason is left as it is; one closed for another reason is refused, as the
 * forge contract does.
 */
export function closeIssue(item: QualifiedPr, reason: CloseReason): void {
  const value = invokeForge('workitem.close', { ref: item, reason });
  if (record(value?.workitem)?.state !== 'closed' || value?.reason !== reason)
    throw new Error('forge returned no verified close');
}

/**
 * Append `## <heading>` and `text` to the issue's body and read it back. A body that
 * already ends with that section is left as it is, so a repeated write adds nothing.
 * The contract has no conditional body write: an edit someone saves between the read
 * here and the write is lost, and the read-back cannot tell.
 */
export function appendSection(item: QualifiedPr, heading: string, text: string): void {
  const section = `## ${heading}\n\n${text.trim()}\n`;
  const body = viewIssue(item).body;
  if (body.trimEnd().endsWith(section.trimEnd())) return;
  // `workitem.edit-body` reads its own write back, and a failure throws with its outcome.
  invokeForge('workitem.edit-body', { ref: item, body: `${body.trimEnd()}\n\n\n${section}` });
}
