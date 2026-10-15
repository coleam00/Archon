/**
 * An eval run's tracker lookups, answered as each batch issue was at creation.
 *
 * A run judging a batch issue must not see how it ended, yet its agent and its
 * scripts read the tracker through `gh`. The runner starts one lookup server per run
 * on a unix socket and launches the run with a `GH_CONFIG_DIR` whose `config.yml` is
 * the operator's own with `http_unix_socket` set to it, so every `gh` call of the run
 * reaches the server. A `gh` on `PATH` would not do: Codex runs each command in a
 * login shell that rebuilds `PATH` from the user's profile, while `GH_CONFIG_DIR`
 * survives it. The server forwards every request to the real host unchanged, then
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
const EMPTY_CONNECTION = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };

const isConnection = (value: unknown): boolean => isObject(value) && ('nodes' in value || 'edges' in value || 'totalCount' in value);

/**
 * The creation view of one issue object, in the shape it arrived in. Only the keys
 * listed here survive, so a field the tracker adds later cannot carry the outcome.
 */
function creationObject(original: Readonly<Record<string, unknown>>, view: CreationView): Record<string, unknown> {
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
    else if (key === 'labels' && isConnection(value)) result[key] = { nodes: view.labels.map(name => ({ name })), totalCount: view.labels.length };
    else if (key === 'comments' && typeof value === 'number') result[key] = 0;
    else if (isConnection(value)) result[key] = EMPTY_CONNECTION;
  }
  return result;
}

const sameText = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

const ISSUE_ID = '_archonBenchIssueId';

/**
 * Ask GitHub to identify issue selections even when the caller requested only state
 * or body. Tokenising GraphQL keeps strings and comments opaque; balanced arguments
 * locate the selection set without assuming variable names, aliases or repositories.
 */
function identifyIssues(body: string | undefined): string | undefined {
  if (body === undefined) return body;
  let request: unknown;
  try {
    request = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isObject(request) || typeof request.query !== 'string') return body;
  const query = request.query;
  const tokens = [...query.matchAll(/"""(?:[^"]|"(?!""))*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|[A-Za-z_]\w*|[^\s,]/g)]
    .filter(token => !token[0].startsWith('#'));
  const insertions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const fragment = tokens[i][0] === 'Issue' && tokens[i - 1]?.[0] === 'on';
    const field = ['issue', 'issueOrPullRequest'].includes(tokens[i][0]) && tokens[i + 1]?.[0] === '(';
    if (!fragment && !field) continue;
    let j = i;
    let depth = 0;
    if (field) {
      for (j = i + 1; j < tokens.length; j++) {
        if (tokens[j][0] === '(') depth++;
        if (tokens[j][0] === ')' && --depth === 0) break;
      }
    }
    // A field may have directives (with their own arguments) before its selection.
    while (tokens[++j]?.[0] === '@') {
      j++;
      if (tokens[j + 1]?.[0] !== '(') continue;
      j += 2;
      depth = 1;
      for (; j < tokens.length; j++) {
        if (tokens[j][0] === '(') depth++;
        if (tokens[j][0] === ')' && --depth === 0) break;
      }
    }
    if (tokens[j]?.[0] === '{') insertions.push(tokens[j].index + 1);
  }
  let identified = query;
  for (const at of insertions.reverse()) identified = `${identified.slice(0, at)} ... on Issue { ${ISSUE_ID}: id } ${identified.slice(at)}`;
  return JSON.stringify({ ...request, query: identified });
}

/** Replace identified batch issues, preserving every unrelated object and field. */
export function atCreation(
  value: unknown,
  views: ReadonlyMap<number, CreationView>
): { value: unknown; answered: Set<number> } {
  const answered = new Set<number>();
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!isObject(node)) return node;
    const original = Object.fromEntries(Object.entries(node).filter(([key]) => key !== ISSUE_ID));
    const view = [...views.values()].find(view =>
      node[ISSUE_ID] === view.id || node.id === view.id || node.node_id === view.id ||
      sameText(node.url, view.url) || sameText(node.html_url, view.url)
    );
    if (view !== undefined) {
      answered.add(view.number);
      return creationObject(original, view);
    }
    return Object.fromEntries(Object.entries(original).map(([key, inner]) => [key, visit(inner)]));
  };
  return { value: visit(value), answered };
}

/**
 * The batch issues a request names by machine identifier: an issue path under the set's
 * repository, or a GraphQL `number` variable or literal. A literal `number` of another
 * repository's object also matches; that errs toward reporting.
 */
function namedIssues(path: string, body: string | undefined, repo: Repo, views: ReadonlyMap<number, CreationView>): number[] {
  const named = new Set<number>();
  const rest = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/.exec(path);
  if (rest !== null && sameText(rest[1], repo.path)) named.add(Number(rest[2]));
  if (path.endsWith('/graphql') && body !== undefined) {
    let request: unknown;
    try {
      request = JSON.parse(body);
    } catch {
      request = undefined;
    }
    if (isObject(request) && isObject(request.variables) && typeof request.variables.number === 'number') named.add(request.variables.number);
    const query = isObject(request) && typeof request.query === 'string' ? request.query : body;
    for (const literal of query.matchAll(/\bnumber\s*:\s*(\d+)/g)) named.add(Number(literal[1]));
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
  const body = sameHost && path.endsWith('/graphql') ? identifyIssues(originalBody) : originalBody;
  const forwarded = await upstream(`https://${host}${url.pathname}${url.search}`, { method: request.method, headers, body });
  const responseHeaders = new Headers(forwarded.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  const bytes = await forwarded.arrayBuffer();
  const init = { status: forwarded.status, statusText: forwarded.statusText, headers: responseHeaders };
  // A refused request, such as a GraphQL query missing a token scope, carries no issue.
  const named = sameHost && forwarded.ok ? namedIssues(path, body, repo, views) : [];
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
  const rewritten = atCreation(parsed, views);
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
