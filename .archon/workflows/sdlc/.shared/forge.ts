/**
 * Standalone client for `archon forge`, the pack's opt-in forge source.
 *
 * One switch selects the source for every forge read and write this pack makes:
 *
 *   gh     the default. The GitHub CLI.
 *   forge  opt-in with `ARCHON_SDLC_FORGE=forge`. An installed forge plugin,
 *          reached through the host command (`ARCHON_CLI_COMMAND`).
 *
 * The source is never inferred from what happens to be installed, and a selected
 * source that cannot answer fails the operation rather than falling back to the
 * other.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note } from './io.ts';

export const FORGE_SOURCES = ['gh', 'forge'] as const;
export type ForgeSource = (typeof FORGE_SOURCES)[number];

// Read here, not in each calling script: the unbound-env checker scans a node-bound
// script's own text but never follows its imports, so a bare process.env read in a
// shared module like this one never trips a false "unbound variable" warning.
export function forgeSource(env: NodeJS.ProcessEnv = process.env): ForgeSource {
  const selected = (env.ARCHON_SDLC_FORGE ?? '').trim();
  if (selected === '') return 'gh';
  const source = FORGE_SOURCES.find(source => source === selected);
  if (source) return source;
  throw new Error(`ARCHON_SDLC_FORGE must be "gh" (the default) or "forge", not "${selected}"`);
}

/** The GitHub forge plugin install id. */
export const GITHUB_FORGE_PLUGIN = 'coleam00/Archon/plugins/forge-github';

const USE_GH = 'To use the GitHub CLI instead, set `ARCHON_SDLC_FORGE=gh`.';
// Per-user GitHub mode scrubs the shared token from a run started by a user who has
// not connected their own identity, so a shared `GH_TOKEN` cannot fix that refusal.
const SETUP =
  'The SDLC pack reaches the forge through a forge plugin. For github.com, install it with ' +
  `\`archon plugin add ${GITHUB_FORGE_PLUGIN}\`, and set \`GH_TOKEN\` in ` +
  "Archon's env file (`~/.archon/.env`, `ARCHON_HOME/.env` when configured, or `/.archon/.env` in Docker), " +
  'set `GITHUB_TOKEN`, use `gh auth login`, or configure GitHub App mode. When per-user GitHub ' +
  'is enabled, connect your own GitHub identity instead of setting `GH_TOKEN`: ' +
  '`archon auth github` or the Web UI Settings page. ' +
  USE_GH;

/**
 * The operator's next step for each refusal the forge contract types as their setup's,
 * keyed by its `error.kind`.
 */
export const REMEDY = {
  no_plugin_for_host: SETUP,
  no_credential: SETUP,
  unsupported_op:
    `For github.com, \`archon plugin update ${GITHUB_FORGE_PLUGIN}\` installs the ` +
    'latest released plugin, which may not support this operation either. ' +
    USE_GH,
} as const;

export interface QualifiedPr {
  readonly repo: { readonly host: string; readonly path: string };
  readonly number: number;
}

/** The pull-request facts every later public action in a run depends on. */
export interface PrRecord extends QualifiedPr {
  readonly schemaVersion: 1;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly is_draft: boolean;
  readonly state: 'open' | 'closed' | 'merged';
  readonly head_repo: { readonly host: string; readonly path: string } | null;
  readonly head_revision: string | null;
  readonly base_revision: string | null;
  readonly maintainer_can_modify: boolean | null;
}

export interface MergeRequest {
  readonly ref: QualifiedPr;
  readonly method: 'merge' | 'squash';
  readonly conditions: { readonly head?: string; readonly base?: string; readonly tree?: string };
}
export interface Landed {
  readonly commit: string | null;
  readonly tree: string | null;
  readonly parents: readonly string[] | null;
}
export interface MergeResult extends Omit<MergeRequest, 'ref'> {
  readonly target: QualifiedPr;
  readonly outcome: 'applied';
  readonly changed: true;
  readonly pr: PrRecord;
  readonly enforcedConditions: readonly (keyof MergeRequest['conditions'])[];
  readonly landed: Landed;
}
export interface ReviewItem {
  readonly kind: 'review' | 'review_comment';
  readonly id: string;
  readonly author: {
    readonly host: string;
    readonly id: string;
    readonly login: string | null;
  } | null;
  readonly commit: string | null;
  readonly state: string | null;
  readonly createdAt: string | null;
  readonly url: string;
  readonly body: string;
}
export interface ReviewsResult {
  readonly ref: QualifiedPr;
  readonly items: readonly ReviewItem[];
}
export interface MutationFailure {
  readonly op: string;
  readonly target: QualifiedPr | QualifiedPr['repo'];
  readonly outcome: 'refused' | 'verification_failed' | 'outcome_unknown';
  readonly leaveBehind?: string;
  readonly observed?: PrRecord;
  readonly merge?: {
    readonly method: MergeRequest['method'];
    readonly conditions: MergeRequest['conditions'];
    readonly landed?: Landed;
  };
}

/**
 * Repository identity, compared the way a forge registers it.
 *
 * Host and owner/name are case-insensitive but case-preserving: a forge answers
 * with the case it has registered, whatever case this pack asked with. Comparing
 * exactly would read a pull request that is the requested one as a different one.
 */
export function sameRepo(left: QualifiedPr['repo'], right: QualifiedPr['repo']): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A forge operation that did not produce a verified result.
 *
 * `mutation` carries the evidence a write owes its caller: which of `refused`,
 * `verification_failed` or `outcome_unknown` happened, and what may remain on the
 * forge. A caller may report it; it may never retry past an unknown outcome.
 */
export class ForgeOperationError extends Error {
  constructor(
    message: string,
    readonly mutation: Record<string, unknown> | undefined
  ) {
    super(message);
    this.name = 'ForgeOperationError';
  }
}

/**
 * A `gh api` failure GitHub typed as passing: a 5xx, a rate limit, or no response.
 * Only {@link retryTransient} repeats the operation that raised it.
 */
export class TransientForgeError extends Error {
  constructor(
    message: string,
    /** The least time GitHub asked to be left alone, in ms; 0 when it named none. */
    readonly waitMs: number
  ) {
    super(message);
    this.name = 'TransientForgeError';
  }
}

/** The waits before each repeat; their count is the number of repeats. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Run `operation`, repeating it while it fails with a {@link TransientForgeError}.
 * Every other failure, and the last transient one, is thrown as it is.
 *
 * Wrap only an operation that is safe to repeat from its start: a read, or a write
 * that first reads whether an earlier attempt already landed. A write that cannot
 * tell must not be wrapped: a gateway timeout can arrive after the forge has
 * applied the request.
 */
export function retryTransient<T>(
  operation: () => T,
  sleep: (ms: number) => void = Bun.sleepSync
): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (!(error instanceof TransientForgeError) || delay === undefined) throw error;
      const wait = Math.max(delay, error.waitMs);
      note(`${error.message}; repeating in ${String(Math.ceil(wait / 1000))}s`);
      sleep(wait);
    }
  }
}

/** One HTTP response as `gh api --include` prints it: status line, headers, body. */
interface GhResponse {
  readonly status: number;
  /** Header names lowercased. */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

function ghResponse(stdout: string): GhResponse | undefined {
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!status) return undefined;
  const lines = stdout.split('\n');
  const end = lines.findIndex(line => line.trim() === '');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1, end === -1 ? undefined : end)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body: end === -1 ? '' : lines.slice(end + 1).join('\n') };
}

/**
 * How long GitHub asked to wait before a failed `gh api` request may be repeated, in
 * ms (0 when it named no time), or undefined when the failure is permanent.
 *
 * A 5xx is transient. A 429, or a 403 carrying `retry-after`, is a rate limit that
 * waits a minute when it names no time, as GitHub documents for a secondary limit.
 * A valid `retry-after` (delta seconds) is the least wait on any retryable status.
 * A failure with no HTTP status is ambiguous (a dropped connection, a timeout, or a
 * local gh error) and is deliberately retried, except gh's exit 4, which is missing
 * authentication; on exhaustion the error keeps gh's own message.
 * Everything else, a 404 or a 422, is permanent.
 */
export function ghRetryWait(
  exitCode: number,
  response: Pick<GhResponse, 'status' | 'headers'> | undefined
): number | undefined {
  if (response === undefined) return exitCode === 4 ? undefined : 0;
  const { status, headers } = response;
  const retryAfter = headers.get('retry-after');
  const seconds = retryAfter === undefined || retryAfter.trim() === '' ? Number.NaN : Number(retryAfter);
  const named = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  if (status === 429 || (status === 403 && retryAfter !== undefined)) return named ?? 60_000;
  return status >= 500 ? (named ?? 0) : undefined;
}

/**
 * Run `gh api <args>` and return the response body. gh names a failed request's
 * status only in stderr prose, so `--include` asks for the status line and headers
 * on stdout, and {@link ghRetryWait} classifies the failure from those. `what`
 * names the request in the error, which carries gh's own message.
 */
export function ghApi(what: string, args: readonly string[]): string {
  const result = Bun.spawnSync(['gh', 'api', ...args, '--include'], { stdout: 'pipe', stderr: 'pipe' });
  const response = ghResponse(result.stdout.toString());
  if (result.exitCode === 0 && response) return response.body;
  const message = `${what} failed: ${result.stderr.toString().trim()}`;
  if (result.exitCode === 0) throw new Error(`${what} returned no HTTP response`);
  const wait = ghRetryWait(result.exitCode, response);
  throw wait === undefined ? new Error(message) : new TransientForgeError(message, wait);
}

/**
 * Run one typed forge operation.
 *
 * The request travels as a file so authored content — a pull-request body, a
 * review report — never appears in any process's argv.
 */
export function invokeForge(
  op: string,
  request: Record<string, unknown>,
  credential?: (source: string) => void
): Record<string, unknown> | null {
  const command = archonCommand();
  const directory = mkdtempSync(join(tmpdir(), 'archon-forge-'));
  const path = join(directory, 'request.json');
  try {
    writeFileSync(path, JSON.stringify(request), { mode: 0o600 });
    const result = Bun.spawnSync([...command, 'forge', op, '--json', '--data-file', path], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString());
    } catch {
      const detail = result.stderr.toString().trim();
      throw new Error(`forge ${op} failed${detail === '' ? '' : `: ${detail}`}`);
    }
    return forgeResult(op, parsed, result.exitCode, credential);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function forgeResult(
  op: string,
  parsed: unknown,
  exitCode: number,
  credential?: (source: string) => void
): Record<string, unknown> | null {
  const response = record(parsed);
  if (!response || typeof response.operationId !== 'string' || response.operationId === '') {
    throw new Error(`forge ${op} returned an unexpected response envelope`);
  }
  const source =
    typeof response.credentialSource === 'string' ? response.credentialSource : undefined;
  if (source) credential?.(source);
  // Exit 2 is the host saying it could not audit an operation that did complete.
  // The response on stdout is the real outcome, so the result is still a result;
  // losing it here would report a performed write as a failure.
  if (response.ok === true && exitCode === 2) {
    note(`forge ${op} completed but the host could not record it in the run's audit log.`);
  } else if (response.ok !== true || exitCode !== 0) {
    const mutation = record(response.mutation);
    const error = record(response.error);
    const outcome = typeof mutation?.outcome === 'string' ? mutation.outcome : undefined;
    const message = typeof error?.message === 'string' ? error.message : 'operation failed';
    const kind = typeof error?.kind === 'string' ? error.kind : undefined;
    const remedy =
      kind !== undefined && Object.hasOwn(REMEDY, kind)
        ? ` ${REMEDY[kind as keyof typeof REMEDY]}`
        : '';
    throw new ForgeOperationError(
      `forge ${op} ${outcome ?? 'failed'}: ${message}${source ? ` (source: ${source})` : ''}${mutation ? ` ${JSON.stringify(mutation)}` : ''}${remedy}`,
      mutation
    );
  }
  const body = record(response.result);
  if (body?.op !== op) throw new Error(`forge ${op} returned the wrong result`);
  // A read may answer "there is none": `pr.view` by head returns null when the
  // branch has no open pull request.
  if (body.value === null) return null;
  const value = record(body.value);
  if (!value) throw new Error(`forge ${op} returned the wrong result`);
  return value;
}

export function qualifiedRepo(value: unknown): QualifiedPr['repo'] | undefined {
  const repo = record(value);
  return typeof repo?.host === 'string' &&
    repo.host.trim() !== '' &&
    typeof repo.path === 'string' &&
    repo.path.trim() !== ''
    ? { host: repo.host, path: repo.path }
    : undefined;
}

/** Validate only the pull-request facts this pack's policy consumes. */
export function parsePrRecord(value: unknown): PrRecord {
  const pr = record(value);
  const repo = qualifiedRepo(pr?.repo);
  const headRepo = pr?.head_repo === null ? null : qualifiedRepo(pr?.head_repo);
  const optionalText = (field: unknown): boolean =>
    field === null || (typeof field === 'string' && field !== '');
  if (
    pr?.schemaVersion !== 1 ||
    !repo ||
    typeof pr.number !== 'number' ||
    !Number.isInteger(pr.number) ||
    pr.number <= 0 ||
    typeof pr.url !== 'string' ||
    !URL.canParse(pr.url) ||
    typeof pr.head !== 'string' ||
    pr.head === '' ||
    typeof pr.base !== 'string' ||
    pr.base === '' ||
    typeof pr.is_draft !== 'boolean' ||
    (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') ||
    headRepo === undefined ||
    !optionalText(pr.head_revision) ||
    !optionalText(pr.base_revision) ||
    !(typeof pr.maintainer_can_modify === 'boolean' || pr.maintainer_can_modify === null)
  ) {
    throw new Error('forge returned an invalid pull-request record');
  }
  return {
    schemaVersion: 1,
    repo,
    number: pr.number,
    url: pr.url,
    head: pr.head,
    base: pr.base,
    is_draft: pr.is_draft,
    state: pr.state,
    head_repo: headRepo,
    head_revision: pr.head_revision as string | null,
    base_revision: pr.base_revision as string | null,
    maintainer_can_modify: pr.maintainer_can_modify,
  };
}

export function parseQualifiedPr(value: string | undefined): QualifiedPr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new Error('the bound pull request is not valid JSON');
  }
  const pr = record(parsed);
  const repo = record(pr?.repo);
  if (
    typeof repo?.host !== 'string' ||
    repo.host.trim() === '' ||
    typeof repo.path !== 'string' ||
    repo.path.trim() === '' ||
    typeof pr?.number !== 'number' ||
    !Number.isInteger(pr.number) ||
    pr.number <= 0
  ) {
    throw new Error('the bound pull request has no qualified repo and positive number');
  }
  return { repo: { host: repo.host, path: repo.path }, number: pr.number };
}

/** The host's `archon` argv, as the CLI and server publish it to every exec node. */
export function archonCommand(): readonly string[] {
  const value = process.env.ARCHON_CLI_COMMAND;
  if (value === undefined || value === '') {
    throw new Error(
      'ARCHON_CLI_COMMAND is not set; the host that started this run did not publish its CLI command'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ARCHON_CLI_COMMAND is not a JSON string array');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(part => typeof part === 'string' && part !== '')
  ) {
    throw new Error('ARCHON_CLI_COMMAND must be a non-empty JSON string array');
  }
  return parsed as string[];
}

export function samePr(left: QualifiedPr, right: QualifiedPr): boolean {
  return left.number === right.number && sameRepo(left.repo, right.repo);
}

export function readRepositoryLabels(repo: QualifiedPr['repo']): string[] {
  const value = invokeForge('repo.labels.list', { repo });
  const observed = qualifiedRepo(value?.repo);
  if (!observed || !sameRepo(repo, observed) || !Array.isArray(value?.labels))
    throw new Error('forge returned invalid repository labels');
  return value.labels.map(row => {
    const label = record(row);
    if (typeof label?.name !== 'string' || label.name === '')
      throw new Error('forge returned invalid repository label');
    return label.name;
  });
}
