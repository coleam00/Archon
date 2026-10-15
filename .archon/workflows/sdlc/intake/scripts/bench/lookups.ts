/**
 * An eval run's tracker lookups, answered as each batch issue was at creation.
 *
 * A run judging a batch issue must not see how it ended, yet its agent and its
 * scripts read the tracker through `gh`. The runner starts one lookup server per run
 * on a unix socket and launches the run with a `GH_CONFIG_DIR` whose `config.yml` is
 * the operator's own with `http_unix_socket` set to it, so every `gh` call of the run
 * reaches the server. A `gh` on `PATH` would not do: Codex runs each command in a
 * login shell that rebuilds `PATH` from the user's profile, while `GH_CONFIG_DIR`
 * survives it. The server forwards requests to the real host, then
 * rewrites each batch issue in the answer to its creation view, and answers a batch
 * issue's comments, events and timeline as empty without forwarding. Anything else
 * answers as live.
 *
 * Batch issues are recognised by node id or web URL. Issue selections in GraphQL
 * requests receive a private id selection, removed from the response, so literal
 * queries and aliases work without guessing which response object a number names.
 * Requests outside the set's forge pass through unchanged. Non-gh reads remain
 * observable through the transcript scan.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QualifiedPr } from '../../../.shared/forge.ts';
import { isObject } from '../../../.shared/typed.ts';

type Repo = QualifiedPr['repo'];

/** What a batch issue answers with: the issue as it was opened. */
export interface CreationView {
  readonly number: number;
  /** The GraphQL node id. */
  readonly id: string;
  /** The web URL. */
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly created_at: string;
}

export interface LabelEvent {
  readonly createdAt: string;
  readonly actor: string | null;
  readonly label: string;
  readonly removed: boolean;
}

/** How long after creation an author's own labelling still counts as part of opening the issue. */
const CREATION_WINDOW_MS = 60_000;

/**
 * The labels an issue was opened with. GitHub records a label set at creation, by
 * `gh issue create --label` or an issue template, as the author's labelled event a
 * second or two after the issue; a later label, by anyone, is part of its outcome.
 */
export function creationLabels(author: string | null, createdAt: string, events: readonly LabelEvent[]): string[] {
  const labels: string[] = [];
  if (author === null) return labels;
  const until = Date.parse(createdAt) + CREATION_WINDOW_MS;
  for (const event of events) {
    if (event.actor !== author || Date.parse(event.createdAt) > until) continue;
    const at = labels.indexOf(event.label);
    if (event.removed && at !== -1) labels.splice(at, 1);
    else if (!event.removed && at === -1) labels.push(event.label);
  }
  return labels;
}

const KEPT = new Set([
  'id',
  'node_id',
  'number',
  'url',
  'html_url',
  'repository_url',
  '__typename',
  'databaseId',
  'author',
  'user',
  'author_association',
  'authorAssociation',
  'createdAt',
  'created_at',
]);
const CLEARED = new Set(['stateReason', 'state_reason', 'closedAt', 'closed_at', 'closed_by']);
const PAGE_INFO = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
const EMPTY_CONNECTION = { nodes: [], edges: [], totalCount: 0, pageInfo: PAGE_INFO };

const isConnection = (value: unknown): boolean => isObject(value) && ('nodes' in value || 'edges' in value || 'totalCount' in value || 'pageInfo' in value);

function labelConnection(labels: readonly string[], args: Readonly<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(args)) {
    if ((name === 'after' || name === 'before') && value === null) continue;
    if ((name !== 'first' && name !== 'last') || typeof value !== 'number' || !Number.isInteger(value) || value < labels.length) {
      throw new Error('the bench cannot answer a partial labels page from the creation snapshot');
    }
  }
  const edges = labels.map((name, index) => ({ node: { name }, cursor: Buffer.from(`bench-label:${String(index)}`).toString('base64') }));
  return {
    nodes: edges.map(edge => edge.node), edges, totalCount: labels.length,
    pageInfo: { ...PAGE_INFO, startCursor: edges[0]?.cursor ?? null, endCursor: edges.at(-1)?.cursor ?? null },
  };
}

/**
 * The creation view of one issue object, in the shape it arrived in. Only the keys
 * listed here survive, so a field the tracker adds later cannot carry the outcome.
 */
function creationObject(original: Readonly<Record<string, unknown>>, view: CreationView, labelArguments: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    if (KEPT.has(key)) result[key] = value;
    else if (key === 'title') result[key] = view.title;
    else if (key === 'body') result[key] = view.body;
    else if (key === 'state') result[key] = typeof value === 'string' && value === value.toUpperCase() ? 'OPEN' : 'open';
    else if (CLEARED.has(key)) result[key] = null;
    else if (key === 'closed') result[key] = false;
    else if (key === 'updatedAt' || key === 'updated_at') result[key] = view.created_at;
    else if (key === 'labels' && Array.isArray(value)) result[key] = view.labels.map(name => ({ name }));
    else if (key === 'labels' && isConnection(value) && isObject(value)) {
      const labels = labelConnection(view.labels, labelArguments);
      result[key] = Object.fromEntries(Object.entries(labels).filter(([name]) => name in value));
    } else if (key === 'comments' && typeof value === 'number') result[key] = 0;
    else if (isConnection(value)) result[key] = EMPTY_CONNECTION;
  }
  return result;
}

const sameText = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

const ISSUE_ID = '_archonBenchIssueId';

interface Selection {
  readonly name: string;
  readonly key: string;
  readonly wireKey: string;
  readonly children: Selections;
  readonly number?: number;
  readonly labelArguments?: Readonly<Record<string, unknown>>;
}
type Selections = readonly (Selection | string)[];
interface Graphql {
  readonly body: string;
  readonly identity: string;
  readonly fields: Selections;
  readonly fragments: ReadonlyMap<string, Selections>;
  readonly numbers: readonly number[];
}

/** Preserve schema-field identity separately from response aliases, including fragments. */
function identifyIssues(body: string | undefined): Graphql | undefined {
  if (body === undefined) return undefined;
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isObject(request) || typeof request.query !== 'string') return undefined;
  const query = request.query;
  const tokens = [...query.matchAll(/"""(?:[^"]|"(?!""))*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|\.\.\.|[A-Za-z_]\w*|[0-9]+|[^\s,]/g)]
    .filter(token => !token[0].startsWith('#'));
  let identity = ISSUE_ID;
  while (tokens.some(token => token[0] === identity)) identity += '_';
  const variables = isObject(request.variables) ? request.variables : {};
  const insertions: number[] = [];
  const aliases: { at: number; end: number; text: string }[] = [];
  const aliasNames = new Map<string, string>();
  const fragments = new Map<string, Selections>();
  let i = 0;
  const token = () => tokens[i]?.[0];
  const skipGroup = (open: string, close: string): void => {
    if (token() !== open) return;
    let depth = 0;
    do {
      if (token() === open) depth++;
      if (token() === close) depth--;
      i++;
    } while (i < tokens.length && depth > 0);
  };
  const directives = (): void => {
    while (token() === '@') {
      i += 2;
      skipGroup('(', ')');
    }
  };
  const selectionSet = (issue = false, inFragment = false): Selections => {
    if (token() !== '{') return [];
    if (issue) insertions.push(tokens[i].index + 1);
    i++;
    const fields: (Selection | string)[] = [];
    while (i < tokens.length && token() !== '}') {
      if (token() === '...') {
        i++;
        if (token() === 'on') {
          i++;
          const type = token();
          i++;
          directives();
          fields.push(...selectionSet(type === 'Issue', true));
        } else if (token() === '@' || token() === '{') {
          directives();
          fields.push(...selectionSet(false, inFragment));
        } else {
          fields.push(token() ?? '');
          i++;
          directives();
        }
        continue;
      }
      const key = token() ?? '';
      const keyToken = tokens[i];
      i++;
      let name = key;
      let wireKey = key;
      if (token() === ':') {
        i++;
        name = token() ?? '';
        i++;
        // Disjoint type fragments may reuse one response alias for different fields.
        if (inFragment) {
          const mapping = `${key}:${name}`;
          wireKey = aliasNames.get(mapping) ?? `${identity}Field${String(aliasNames.size)}`;
          while (tokens.some(token => token[0] === wireKey)) wireKey += '_';
          aliasNames.set(mapping, wireKey);
          aliases.push({ at: keyToken.index, end: keyToken.index + key.length, text: wireKey });
        }
      }
      const issueField = name === 'issue' || name === 'issueOrPullRequest';
      let issueNumber: number | undefined;
      if (issueField && token() === '(') {
        for (let j = i + 1; j < tokens.length && tokens[j][0] !== ')'; j++) {
          if (tokens[j][0] !== 'number' || tokens[j + 1]?.[0] !== ':') continue;
          const value = tokens[j + 2]?.[0];
          const number = value === '$' ? variables[tokens[j + 3]?.[0] ?? ''] : Number(value);
          if (typeof number === 'number') issueNumber = number;
        }
      }
      const labelArguments: Record<string, unknown> = {};
      if (name === 'labels' && token() === '(') {
        for (let j = i + 1; j < tokens.length && tokens[j][0] !== ')'; j++) {
          if (tokens[j + 1]?.[0] !== ':') continue;
          const value = tokens[j + 2]?.[0] ?? '';
          labelArguments[tokens[j][0]] = value === '$' ? variables[tokens[j + 3]?.[0] ?? '']
            : value === 'null' ? null : Number(value);
        }
      }
      skipGroup('(', ')');
      directives();
      fields.push({ key, wireKey, name, number: issueNumber, labelArguments, children: selectionSet(issueField, inFragment) });
    }
    i++;
    return fields;
  };
  const operations = new Map<string, Selections>();
  while (i < tokens.length) {
    if (token() === 'fragment') {
      const name = tokens[i + 1]?.[0] ?? '';
      const type = tokens[i + 3]?.[0];
      i += 4;
      directives();
      fragments.set(name, selectionSet(type === 'Issue', true));
    } else {
      let name = '';
      if (token() !== '{') {
        i++;
        if (token() !== '(' && token() !== '{' && token() !== '@') {
          name = token() ?? '';
          i++;
        }
        skipGroup('(', ')');
        directives();
      }
      operations.set(name, selectionSet());
    }
  }
  let identified = query;
  const edits = [...aliases, ...insertions.map(at => ({ at, end: at, text: ` ... on Issue { ${identity}: id } ` }))];
  for (const edit of edits.sort((a, b) => b.at - a.at)) identified = `${identified.slice(0, edit.at)}${edit.text}${identified.slice(edit.end)}`;
  const fields = typeof request.operationName === 'string'
    ? operations.get(request.operationName) ?? []
    : operations.size === 1 ? [...operations.values()][0] : [];
  const numbers = (selections: Selections): number[] => selectedFields(selections, { fragments }).flatMap(field => [
    ...(field.number === undefined ? [] : [field.number]), ...numbers(field.children),
  ]);
  return { body: edits.length === 0 ? body : JSON.stringify({ ...request, query: identified }), identity, fields, fragments, numbers: numbers(fields) };
}

function selectedFields(fields: Selections, graphql: Pick<Graphql, 'fragments'>): Selection[] {
  const merged = new Map<string, Selection>();
  for (const field of fields.flatMap(field => typeof field === 'string' ? selectedFields(graphql.fragments.get(field) ?? [], graphql) : [field])) {
    const previous = merged.get(field.wireKey);
    merged.set(field.wireKey, previous === undefined ? field : { ...field, children: [...previous.children, ...field.children] });
  }
  return [...merged.values()];
}

function mergeResponse(left: unknown, right: unknown): unknown {
  if (Array.isArray(left) && Array.isArray(right)) return right.map((value, index) => mergeResponse(left[index], value));
  if (isObject(left) && isObject(right)) return mergeEntries([...Object.entries(left), ...Object.entries(right)]);
  return right;
}

function mergeEntries(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of entries) result.set(key, result.has(key) ? mergeResponse(result.get(key), value) : value);
  return Object.fromEntries(result);
}

function projectSelection(value: unknown, fields: Selections, graphql: Graphql): unknown {
  if (Array.isArray(value)) return value.map(inner => projectSelection(inner, fields, graphql));
  if (!isObject(value)) return value;
  return mergeEntries(selectedFields(fields, graphql)
    .filter(field => field.name in value)
    .map(field => [field.key, projectSelection(value[field.name], field.children, graphql)] as const));
}

/** Replace identified batch issues, preserving every unrelated object and field. */
export function atCreation(
  value: unknown,
  views: ReadonlyMap<number, CreationView>,
  graphql?: Graphql
): { value: unknown; answered: Set<number> } {
  const answered = new Set<number>();
  const visit = (node: unknown, selections: Selections): unknown => {
    if (Array.isArray(node)) return node.map(inner => visit(inner, selections));
    if (!isObject(node)) return node;
    const fields = graphql === undefined ? [] : selectedFields(selections, graphql);
    const identity = graphql?.identity ?? ISSUE_ID;
    const original = Object.fromEntries(Object.entries(node).filter(([key]) => key !== identity));
    const view = [...views.values()].find(view =>
      node[identity] === view.id || fields.some(field =>
        (field.name === 'id' && node[field.wireKey] === view.id) ||
        (field.name === 'url' && sameText(node[field.wireKey], view.url))
      ) || (graphql === undefined && (
        node.id === view.id || node.node_id === view.id || sameText(node.url, view.url) || sameText(node.html_url, view.url)
      ))
    );
    if (view !== undefined) {
      answered.add(view.number);
      if (graphql === undefined) return creationObject(original, view);
      return mergeEntries(fields.flatMap(field => {
        if (!(field.wireKey in original)) return [];
        const inner = original[field.wireKey];
        const canonical = isObject(inner) ? Object.fromEntries(Object.entries(inner).map(([key, value]) => [
          selectedFields(field.children, graphql).find(child => child.wireKey === key)?.name ?? key, value,
        ])) : inner;
        const rewritten = creationObject({ [field.name]: canonical }, view, field.labelArguments);
        if (!(field.name in rewritten)) return [];
        const value = KEPT.has(field.name) ? visit(original[field.wireKey], field.children) : projectSelection(rewritten[field.name], field.children, graphql);
        return [[field.key, value] as const];
      }));
    }
    return mergeEntries(Object.entries(original).map(([key, inner]) => {
      const field = fields.find(field => field.wireKey === key);
      return [field?.key ?? key, visit(inner, field?.children ?? [])] as const;
    }));
  };
  return { value: visit(value, graphql === undefined ? [] : [{ key: 'data', wireKey: 'data', name: 'data', children: graphql.fields }]), answered };
}

/**
 * The batch issues a request names by machine identifier: an issue path under the set's
 * repository, or a parsed GraphQL issue selection's number. A number of another
 * repository's object also matches; that errs toward reporting.
 */
function namedIssues(path: string, graphql: Graphql | undefined, repo: Repo, views: ReadonlyMap<number, CreationView>): number[] {
  const named = new Set<number>();
  const rest = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/.exec(path);
  if (rest !== null && sameText(rest[1], repo.path)) named.add(Number(rest[2]));
  if (path.endsWith('/graphql')) {
    for (const number of graphql?.numbers ?? []) named.add(number);
  }
  return [...named].filter(number => views.has(number));
}

const DROPPED_REQUEST_HEADERS = ['host', 'accept-encoding', 'connection', 'content-length'];
const DROPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

export interface Answer {
  readonly response: Response;
  /** Batch issues the answer gave as they were at creation. */
  readonly answered: number[];
  /** Batch issues the request named that the answer gave as they are now. */
  readonly live: number[];
}

/** Answer one request a run's `gh` sent. */
export async function answerLookup(
  request: Request,
  repo: Repo,
  views: ReadonlyMap<number, CreationView>,
  upstream: (url: string, init: RequestInit) => Promise<Response>
): Promise<Answer> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v3(?=\/)/, '');
  const host = request.headers.get('host') ?? url.host;
  const sameHost = sameText(host, repo.host === 'github.com' ? 'api.github.com' : repo.host);
  const history = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(comments|events|timeline|labels)$/.exec(path);
  const local = sameHost && history !== null && sameText(history[1], repo.path) ? views.get(Number(history[2])) : undefined;
  if (request.method === 'GET' && local !== undefined && history !== null) {
    const answer = history[3] === 'labels' ? local.labels.map(name => ({ name })) : [];
    return { response: Response.json(answer), answered: [local.number], live: [] };
  }

  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const originalBody = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const graphql = sameHost && path.endsWith('/graphql') ? identifyIssues(originalBody) : undefined;
  const body = graphql?.body ?? originalBody;
  const forwarded = await upstream(`https://${host}${url.pathname}${url.search}`, { method: request.method, headers, body });
  const responseHeaders = new Headers(forwarded.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  const bytes = await forwarded.arrayBuffer();
  const init = { status: forwarded.status, statusText: forwarded.statusText, headers: responseHeaders };
  // A refused request, such as a GraphQL query missing a token scope, carries no issue.
  const named = sameHost && forwarded.ok ? namedIssues(path, graphql, repo, views) : [];
  const unchanged = { response: new Response(bytes, init), answered: [], live: named };
  if (!(forwarded.headers.get('content-type') ?? '').includes('json')) return unchanged;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return unchanged;
  }
  const refused = isObject(parsed) && parsed.data == null && 'errors' in parsed;
  if (!sameHost) return unchanged;
  const rewritten = atCreation(parsed, views, graphql);
  if (rewritten.answered.size === 0 && body === originalBody) return refused ? { ...unchanged, live: [] } : unchanged;
  const answered = [...rewritten.answered];
  // Enriched selections carry their own identity. An unmatched number can name a
  // sibling PR or an issue in another repository, not a live read of this batch.
  const live = body !== originalBody || refused ? [] : named.filter(number => !answered.includes(number));
  return { response: new Response(JSON.stringify(rewritten.value), init), answered, live };
}

/** The operator's gh configuration directory, in gh's own order of precedence. */
export function ghConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'gh');
  if (process.platform === 'win32' && env.AppData) return join(env.AppData, 'GitHub CLI');
  return join(homedir(), '.config', 'gh');
}

export interface LookupServer {
  /** The launch environment that sends the run's `gh` calls to this server. */
  readonly env: { readonly GH_CONFIG_DIR: string };
  /** How many requests the server answered with this batch issue's creation view. */
  answered(number: number): number;
  /** The requests that named this batch issue and were answered live, by method and path. */
  answeredLive(number: number): readonly string[];
  stop(): void;
}

/**
 * Start one run's lookup server. Its gh config is the operator's with the socket set,
 * and its `hosts.yml` links to the operator's, so the run authenticates as the
 * operator does. The directory lives under the system temp directory because a unix
 * socket path is capped near 104 bytes on macOS.
 */
export function serveLookups(repo: Repo, views: ReadonlyMap<number, CreationView>): LookupServer {
  const dir = mkdtempSync(join(tmpdir(), 'archon-bench-'));
  try {
    const socket = join(dir, 'gh.sock');
    const operator = ghConfigDir(process.env);
    const configFile = join(operator, 'config.yml');
    const config: unknown = existsSync(configFile) ? (Bun.YAML.parse(readFileSync(configFile, 'utf8')) ?? {}) : {};
    if (!isObject(config)) throw new Error(`${configFile} is not a mapping`);
    writeFileSync(join(dir, 'config.yml'), Bun.YAML.stringify({ ...config, http_unix_socket: socket }, null, 2));
    if (existsSync(join(operator, 'hosts.yml'))) symlinkSync(join(operator, 'hosts.yml'), join(dir, 'hosts.yml'));
    const counts = new Map<number, number>();
    const live = new Map<number, string[]>();
    const server = Bun.serve({
      unix: socket,
      async fetch(request) {
        const answer = await answerLookup(request, repo, views, (url, init) => fetch(url, init));
        for (const number of answer.answered) counts.set(number, (counts.get(number) ?? 0) + 1);
        for (const number of answer.live) live.set(number, [...(live.get(number) ?? []), `${request.method} ${new URL(request.url).pathname}`]);
        return answer.response;
      },
      error(error) {
        return new Response(`the bench lookup server could not answer: ${error.message}`, { status: 502 });
      },
    });
    return {
      env: { GH_CONFIG_DIR: dir },
      answered: number => counts.get(number) ?? 0,
      answeredLive: number => live.get(number) ?? [],
      stop() {
        void server.stop(true);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
