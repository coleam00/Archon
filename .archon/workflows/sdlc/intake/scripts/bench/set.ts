/**
 * The intake bench's pinned set: issues with known outcomes, each with the title and
 * body it was opened with, so every rerun judges the same text.
 *
 * Selection reads the tracker and writes only the set file. Which workflow judges a
 * row is pinned here too: a listed maintainer's issue runs through intake in eval
 * mode; an outside author's issue runs through archon-triage-block on the same
 * creation text, because eval intake never triages an outside item; and a
 * `trust: outside` row is a maintainer's issue run through intake as an outside
 * author's, to prove no agent starts on it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isId } from '../../../.shared/bench.ts';
import type { QualifiedPr } from '../../../.shared/forge.ts';
import { type IssueAtCreation, issueAtCreation, viewIssue } from '../../../.shared/issue.ts';
import { type Contract, type Route, ROUTE_LABEL, STATE_LABEL, TYPE_LABEL, type WorkType } from '../../../.shared/labels.ts';
import { isObject } from '../../../.shared/typed.ts';
import { readMaintainers } from '../../../.shared/workitem.ts';

type Repo = QualifiedPr['repo'];

/** Each group, and whether its issues were still open when the set was pinned. */
export const GROUP_OPEN = { duplicate: false, fixed: false, not_planned: false, typed: true, dispositioned: true } as const;
export type Group = keyof typeof GROUP_OPEN;
export const GROUPS = Object.keys(GROUP_OPEN) as Group[];
export const WORKFLOWS = { intake: 'archon-intake', triage: 'archon-triage-block' } as const;
export type BenchWorkflow = keyof typeof WORKFLOWS;

export const CONTRACTS = ['READY', ...Object.keys(STATE_LABEL)] as Contract[];
export const ROUTES = Object.keys(ROUTE_LABEL) as Route[];
export const WORK_TYPES = Object.keys(TYPE_LABEL) as WorkType[];

/**
 * The human type labels the bench reads as a known `type`. `enhancement` and
 * `feature` are the same type. A label the pack writes itself is never one of these.
 */
export const HUMAN_TYPE_LABELS: Readonly<Record<string, WorkType>> = {
  bug: 'bug',
  enhancement: 'feature',
  feature: 'feature',
  documentation: 'docs',
  docs: 'docs',
  refactor: 'refactor',
  question: 'question',
  maintenance: 'maintenance',
  chore: 'maintenance',
};

/** What a person already decided about an open issue, from the operator's file. */
export interface Disposition {
  readonly contract: Contract;
  readonly route?: Route;
  readonly note?: string;
}

/** The outcome a row is scored against; a field is present only when it is known. */
export interface Known {
  /** The issue a duplicate was closed in favour of. */
  readonly canonical?: string;
  /** The merged pull request that closed the issue. */
  readonly fixed_by?: string;
  /** The type a person labelled the issue with. */
  readonly type?: WorkType;
  readonly disposition?: Disposition;
}

export interface Row {
  /** The issue number, with `-outside` for its `trust: outside` row. */
  readonly id: string;
  readonly number: number;
  readonly group: Group;
  readonly workflow: BenchWorkflow;
  readonly trust: 'auto' | 'outside';
  readonly author: string | null;
  readonly title: string;
  readonly body: string;
  readonly body_from: IssueAtCreation['body_from'];
  readonly known: Known;
}

export interface BenchSet {
  readonly bench: 'intake';
  readonly repo: Repo;
  readonly selected_at: string;
  readonly rows: readonly Row[];
}

export const BATCH_SIZE = 5;

/** Batch `n` (from 1): the n-th five rows of the set, in its pinned order. */
export function batchRows(set: BenchSet, batch: number): readonly Row[] {
  const count = Math.ceil(set.rows.length / BATCH_SIZE);
  if (!Number.isInteger(batch) || batch < 1 || batch > count) {
    throw new Error(`batch must be 1 to ${String(count)}, not ${String(batch)}`);
  }
  return set.rows.slice((batch - 1) * BATCH_SIZE, batch * BATCH_SIZE);
}

export function loadSet(file: string): BenchSet {
  const set: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const refuse = (reason: string): never => {
    throw new Error(`set ${file}: ${reason}`);
  };
  if (!isObject(set) || set.bench !== 'intake' || !isObject(set.repo) || !Array.isArray(set.rows)) {
    return refuse('is not an intake bench set');
  }
  const ids = new Set<string>();
  for (const row of set.rows as unknown[]) {
    if (!isObject(row) || !isId(row.id) || ids.has(row.id)) return refuse('has a row without a unique id');
    ids.add(row.id);
    if (!(row.workflow === 'intake' || row.workflow === 'triage')) return refuse(`row ${row.id} names no workflow`);
    if (row.trust === 'outside' && row.workflow !== 'intake') return refuse(`row ${row.id} is trust: outside outside intake`);
  }
  return set as unknown as BenchSet;
}

function gh(host: string, args: readonly string[]): unknown {
  const result = Bun.spawnSync(['gh', 'api', '--hostname', host, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`gh api ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString());
}

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue {
      number
      author { login }
      labels(first: 50) { nodes { name } }
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent {
        duplicateOf { ... on Issue { url } }
        closer { ... on PullRequest { url merged } }
      } } }
    } }
  }
}`;

/** One search hit, reduced to what selection reads. */
export interface Candidate {
  readonly number: number;
  readonly author: string | null;
  readonly labels: readonly string[];
  readonly duplicateOf: string | null;
  readonly closedBy: string | null;
}

export function toCandidate(node: unknown): Candidate | undefined {
  if (!isObject(node) || typeof node.number !== 'number') return undefined;
  const login = isObject(node.author) && typeof node.author.login === 'string' ? node.author.login : null;
  const labels = isObject(node.labels) && Array.isArray(node.labels.nodes) ? node.labels.nodes : [];
  const closed = isObject(node.timelineItems) && Array.isArray(node.timelineItems.nodes) ? node.timelineItems.nodes[0] : undefined;
  const duplicateOf = isObject(closed) && isObject(closed.duplicateOf) ? closed.duplicateOf.url : undefined;
  const closer = isObject(closed) && isObject(closed.closer) ? closed.closer : undefined;
  return {
    number: node.number,
    author: login,
    labels: labels.flatMap(label => (isObject(label) && typeof label.name === 'string' ? [label.name] : [])),
    duplicateOf: typeof duplicateOf === 'string' ? duplicateOf : null,
    closedBy: closer?.merged === true && typeof closer.url === 'string' ? closer.url : null,
  };
}

/** Search hits in the tracker's order, newest first, until `enough` of them qualify. */
function search(repo: Repo, query: string, qualifies: (candidate: Candidate) => boolean, enough: number): Candidate[] {
  const found: Candidate[] = [];
  if (enough === 0) return found;
  let after: string | null = null;
  do {
    const page: unknown = gh(repo.host, [
      'graphql',
      '-f',
      `query=${SEARCH}`,
      '-f',
      `q=repo:${repo.path} is:issue ${query} sort:created-desc`,
      ...(after === null ? [] : ['-f', `after=${after}`]),
    ]);
    const result = isObject(page) && isObject(page.data) && isObject(page.data.search) ? page.data.search : undefined;
    if (result === undefined || !Array.isArray(result.nodes)) throw new Error(`the search "${query}" returned no results object`);
    for (const node of result.nodes) {
      const candidate = toCandidate(node);
      if (candidate !== undefined && qualifies(candidate)) found.push(candidate);
      if (found.length === enough) return found;
    }
    const info = isObject(result.pageInfo) ? result.pageInfo : {};
    after = info.hasNextPage === true && typeof info.endCursor === 'string' ? info.endCursor : null;
  } while (after !== null);
  return found;
}

/** The type a person labelled the issue with, when its type labels agree on one. */
export function humanType(labels: readonly string[]): WorkType | undefined {
  const types = new Set(labels.flatMap(label => (Object.hasOwn(HUMAN_TYPE_LABELS, label) ? [HUMAN_TYPE_LABELS[label]] : [])));
  return types.size === 1 ? [...types][0] : undefined;
}

export function parseDispositions(file: string): Map<number, Disposition> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const refuse = (reason: string): never => {
    throw new Error(`dispositions ${file}: ${reason}`);
  };
  if (!Array.isArray(raw)) return refuse('must be a JSON array');
  const dispositions = new Map<number, Disposition>();
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry.number !== 'number' || !Number.isInteger(entry.number) || entry.number < 1) {
      return refuse('every entry needs a positive issue `number`');
    }
    const { number, contract, route, note } = entry;
    if (!CONTRACTS.includes(contract as Contract)) return refuse(`issue ${String(number)}: contract must be one of ${CONTRACTS.join(', ')}`);
    if (route !== undefined && (contract !== 'READY' || !ROUTES.includes(route as Route))) {
      return refuse(`issue ${String(number)}: only a READY disposition names a route, one of ${ROUTES.join(', ')}`);
    }
    if (note !== undefined && typeof note !== 'string') return refuse(`issue ${String(number)}: note must be text`);
    dispositions.set(number, { contract: contract as Contract, ...(route === undefined ? {} : { route: route as Route }), ...(note === undefined ? {} : { note }) });
  }
  return dispositions;
}

export interface SelectCounts {
  readonly duplicate: number;
  readonly fixed: number;
  readonly not_planned: number;
  readonly typed: number;
  readonly outside: number;
}

interface Picked {
  readonly candidate: Candidate;
  readonly group: Group;
  readonly known: Known;
}

/**
 * Interleave the groups, one row of each in turn, so every batch of five mixes
 * groups; each `trust: outside` row follows the row it copies.
 */
export function orderRows(rows: readonly Row[]): Row[] {
  const byGroup = GROUPS.map(group => rows.filter(row => row.group === group && row.trust === 'auto'));
  const ordered: Row[] = [];
  for (let index = 0; byGroup.some(group => index < group.length); index++) {
    for (const group of byGroup) {
      const row = group[index];
      if (row === undefined) continue;
      ordered.push(row);
      const outside = rows.find(other => other.id === `${row.id}-outside`);
      if (outside !== undefined) ordered.push(outside);
    }
  }
  return ordered;
}

/** Pick the set from the tracker and pin it to `file`, which must not exist yet. */
export function selectSet(
  repo: Repo,
  file: string,
  counts: SelectCounts,
  dispositions: ReadonlyMap<number, Disposition>
): BenchSet {
  if (existsSync(file)) throw new Error(`${file} exists; a pinned set is never rewritten`);
  const maintainers = readMaintainers(repo);
  const picked: Picked[] = [];
  const taken = new Set<number>();
  const pick = (group: Group, candidates: readonly Candidate[], known: (candidate: Candidate) => Known): void => {
    for (const candidate of candidates) {
      if (taken.has(candidate.number)) continue;
      taken.add(candidate.number);
      const type = humanType(candidate.labels);
      picked.push({ candidate, group, known: { ...(type === undefined ? {} : { type }), ...known(candidate) } });
    }
  };
  const fresh = (candidate: Candidate): boolean => !taken.has(candidate.number);
  // Dispositioned issues are picked first, so an open typed search cannot take one.
  for (const [number, disposition] of dispositions) {
    const issue = viewIssue({ repo, number });
    if (issue.state !== 'open') throw new Error(`dispositioned issue ${String(number)} is not open`);
    pick('dispositioned', [{ number, author: issue.author ?? null, labels: issue.labels, duplicateOf: null, closedBy: null }], () => ({ disposition }));
  }
  // A duplicate counts only when the tracker records what it duplicates.
  pick('duplicate', search(repo, 'is:closed reason:duplicate', c => fresh(c) && c.duplicateOf !== null, counts.duplicate), c => ({
    canonical: c.duplicateOf ?? undefined,
  }));
  pick('fixed', search(repo, 'is:closed reason:completed linked:pr', c => fresh(c) && c.closedBy !== null, counts.fixed), c => ({
    fixed_by: c.closedBy ?? undefined,
  }));
  pick('not_planned', search(repo, 'is:closed reason:"not planned"', fresh, counts.not_planned), () => ({}));
  const typeLabels = Object.keys(HUMAN_TYPE_LABELS).join(',');
  pick('typed', search(repo, `is:open label:${typeLabels}`, c => fresh(c) && humanType(c.labels) !== undefined, counts.typed), () => ({}));

  // A short group pins a set that cannot measure its own bar, and a pinned set is never rewritten.
  for (const group of ['duplicate', 'fixed', 'not_planned', 'typed'] as const) {
    const found = picked.filter(entry => entry.group === group).length;
    if (found < counts[group]) throw new Error(`only ${String(found)} ${group} issues were found; the set asks for ${String(counts[group])}`);
  }

  const isMaintainer = (author: string | null): boolean => author !== null && maintainers.has(author.toLowerCase());
  const rows: Row[] = [];
  for (const { candidate, group, known } of picked) {
    const subject = { repo, number: candidate.number };
    const created = issueAtCreation(subject, viewIssue(subject));
    const maintainer = isMaintainer(candidate.author);
    const row: Row = {
      id: String(candidate.number),
      number: candidate.number,
      group,
      workflow: maintainer ? 'intake' : 'triage',
      trust: 'auto',
      author: candidate.author,
      title: created.title,
      body: created.body,
      body_from: created.body_from,
      known,
    };
    rows.push(row);
  }
  // The trust: outside rows: maintainers' issues, spread over the groups in turn.
  const outsideSources = orderRows(rows).filter(row => row.workflow === 'intake').slice(0, counts.outside);
  if (outsideSources.length < counts.outside) {
    throw new Error(`only ${String(outsideSources.length)} maintainer issues were selected; ${String(counts.outside)} trust: outside rows need that many`);
  }
  for (const row of outsideSources) rows.push({ ...row, id: `${row.id}-outside`, trust: 'outside' });

  const set: BenchSet = { bench: 'intake', repo, selected_at: new Date().toISOString(), rows: orderRows(rows) };
  writeFileSync(file, `${JSON.stringify(set, null, 2)}\n`, { flag: 'wx' });
  return set;
}
