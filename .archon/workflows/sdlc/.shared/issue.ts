/**
 * The pack's one issue read, through whichever source the run selected (./forge.ts).
 *
 * Both sources prove the number names an issue on the tracker before anything is
 * returned, so a pull request with the same number is never read as the issue.
 * `issueAtCreation` recovers the text an issue was opened with, from GitHub's edit
 * history; the forge source has no history and answers with the current text.
 */

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

function ghView(item: QualifiedPr): IssueView {
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
  if (
    issue?.number !== item.number ||
    (typeof issue.html_url === 'string' ? issue.html_url : '').toLowerCase() !==
      url.toLowerCase() ||
    'pull_request' in issue
  ) {
    throw new Error(`tracker identity mismatch: ${url} does not answer as that issue`);
  }
  if (issue.state !== 'open' && issue.state !== 'closed') {
    throw new Error(`${url} has no open or closed state`);
  }
  return {
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    author: login(record(issue.user)?.login),
    labels: labelNames(Array.isArray(issue.labels) ? issue.labels : []),
    state: issue.state,
    url: issue.html_url as string,
  };
}

function forgeView(item: QualifiedPr): IssueView {
  const value = invokeForge('workitem.view', { ref: item });
  const observed = parseQualifiedPr(JSON.stringify(value?.ref));
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

/** The title and body an issue was opened with, and whether the body really is that. */
export interface IssueAtCreation {
  readonly title: string;
  readonly body: string;
  /** `current` when the creation body could not be recovered and the current one stands in. */
  readonly body_from: 'creation' | 'current';
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
  const slash = item.repo.path.indexOf('/');
  const result = Bun.spawnSync(
    [
      'gh',
      'api',
      'graphql',
      '--hostname',
      item.repo.host,
      '-f',
      `query=${CREATION_QUERY}`,
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
    throw new Error(
      `gh api graphql (issue ${String(item.number)} history) failed: ${result.stderr.toString().trim()}`
    );
  }
  const data = record(record(JSON.parse(result.stdout.toString()))?.data);
  const history = record(record(data?.repository)?.issue);
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
