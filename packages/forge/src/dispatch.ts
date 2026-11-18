import { z } from 'zod';
import {
  forgeAuditResponse,
  forgeOperationAuditSchema,
  forgeRequestSchema,
  forgeResponseSchema,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
  PR_VIEW_ANY_STATE,
  RESOLVE_SUBJECT,
  temporaryErrorKinds,
  type ForgeAccessRefusalKind,
  type ForgeError,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';
import type { RepoRef } from './identity';
import {
  discoverPlugins,
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type PluginDiscovery,
  type SourcePlugin,
} from './discovery';
import { normalizeHost, type ForgePluginConfig } from './plugin-config';
import { runPluginProcess, type PluginProcessResult } from './plugin-process';
import { selectCredential } from './credentials';
import { GH_DOTCOM_TOKEN_KEYS } from '@archon/paths/github-token-env';
import { parseRemoteUrl } from './remote-url';
import { httpsDefaultPortRemoteHost, matchesForgeOperationResponse } from './response-match';

export type ForgeOperationAudit = z.infer<typeof forgeOperationAuditSchema>;
export interface ForgeDispatchResult {
  response: ForgeResponse;
  plugin: Pick<PluginMetadata, 'name' | 'version'> | null;
  audit: ForgeOperationAudit;
  credentialSource?: string;
}

/**
 * A dispatch-level failure.
 *
 * `outcome` says whether the plugin could have written anything before the failure:
 * `refused` only where nothing ran, `outcome_unknown` once a process was launched
 * and its result was lost. A reader may never widen that in the other direction.
 */
function errorResponse(
  request: ForgeRequest,
  error: ForgeError,
  outcome: 'refused' | 'outcome_unknown' = 'refused'
): ForgeResponse {
  return {
    operationId: request.operationId,
    ok: false,
    error,
    ...(isMutationRequest(request)
      ? {
          mutation: {
            op: request.op,
            target: mutationTarget(request),
            outcome,
            ...mutationAttempt(request),
          },
        }
      : {}),
  };
}

function requestRepo(request: Exclude<ForgeRequest, { op: 'resolve' }>): RepoRef {
  if ('repo' in request) return request.repo;
  if (request.op === 'pr.view')
    return request.selector.kind === 'head' ? request.selector.repo : request.selector.ref.repo;
  if ('subject' in request) return request.subject.ref.repo;
  return request.ref.repo;
}

function requestTarget(
  request: ForgeRequest,
  response?: ForgeResponse
): ForgeOperationAudit['target'] {
  if ('repo' in request) return request.repo;
  if (request.op === 'pr.view')
    return request.selector.kind === 'head' ? request.selector.repo : request.selector.ref;
  if ('subject' in request) return request.subject.ref;
  if (request.op !== 'resolve') return request.ref;
  if (
    response?.ok &&
    response.result.op === 'resolve' &&
    response.result.value.kind === 'resolved'
  ) {
    return response.result.value.repo;
  }
  return null;
}

function remoteHost(remote: string | null): string | undefined {
  if (!remote || /^[./~]|^[A-Za-z]:[\\/]/.test(remote)) return undefined;
  try {
    const scp = /^(?:[^@\s]+@)?([^:/\s]+):.+$/.exec(remote);
    if (scp && !remote.includes('://')) return normalizeHost(scp[1]);
    const { url, host } = parseRemoteUrl(remote.trim());
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    return normalizeHost(host);
  } catch {
    return undefined;
  }
}

function selectHost(discovery: PluginDiscovery, request: ForgeRequest, host: string): string {
  if (request.op !== 'resolve') return requestRepo(request).hostClaim ? host.slice(0, -4) : host;
  return request.remote === null ? host : remotePluginHost(discovery, request.remote, host);
}

/** The claim whose plugin serves `remote`, whose own host is `host`: what `resolve` selects. */
function remotePluginHost(discovery: PluginDiscovery, remote: string, host: string): string {
  if (!discovery.byHost.has(host)) return httpsDefaultPortRemoteHost(remote) ?? host;
  return host;
}

function retainHostClaim(response: ForgeResponse, host: string, claim: string): ForgeResponse {
  if (!response.ok || response.result.op !== 'resolve' || response.result.value.kind !== 'resolved')
    return response;
  const value = response.result.value;
  return {
    ...response,
    result: {
      op: 'resolve',
      value: {
        ...value,
        repo: {
          ...value.repo,
          host: normalizeHost(value.repo.host) === host ? value.repo.host : host,
          hostClaim: host === claim ? undefined : true,
        },
      },
    },
  };
}

function discoveryFailure(error: unknown): ForgeError {
  return error instanceof PluginDiscoveryError
    ? { kind: error.kind, message: error.message }
    : { kind: 'process_failed', message: 'forge plugin discovery failed' };
}

interface DispatchOptions {
  config?: ForgePluginConfig;
  env?: NodeJS.ProcessEnv;
  credentialEnv?: NodeJS.ProcessEnv;
  discovery?: PluginDiscovery;
  /** Passed to `discoverPlugins`; the host owns where installed plugins live. */
  pluginsDir?: string;
  /** Passed to `discoverPlugins`; set only by a host running from source. */
  sourcePlugins?: readonly SourcePlugin[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** How the host waits between repeats of a read; tests replace it so they do not sleep. */
  sleep?: (ms: number) => Promise<unknown>;
}

interface Dispatched {
  response: ForgeResponse;
  retries?: number;
  plugin: ForgeDispatchResult['plugin'];
  credentialSource?: string;
}

/** The hosts one dispatch reads: the repository's own, and the claim that selected its plugin. */
interface DispatchHosts {
  repository: string;
  selected: string;
}

type OperationCredential = Awaited<ReturnType<typeof selectCredential>>;

export async function dispatchForge(
  input: ForgeRequest,
  options: DispatchOptions = {}
): Promise<ForgeDispatchResult> {
  const started = performance.now();
  const request = forgeRequestSchema.parse(input);
  const { response, plugin, credentialSource, retries = 0 } = await dispatch(request, options);
  return {
    ...finish(request, plugin, named(request, response, retries), retries, started),
    ...(credentialSource ? { credentialSource } : {}),
  };
}

async function dispatch(request: ForgeRequest, options: DispatchOptions): Promise<Dispatched> {
  const host =
    request.op === 'resolve'
      ? remoteHost(request.remote)
      : normalizeHost(requestRepo(request).host);
  if (request.op === 'resolve' && !host) return { response: noForge(request), plugin: null };
  let discovery: PluginDiscovery;
  try {
    discovery = await discover(options);
  } catch (error) {
    return { response: errorResponse(request, discoveryFailure(error)), plugin: null };
  }
  const repository = host ?? '';
  const hosts: DispatchHosts = { repository, selected: selectHost(discovery, request, repository) };
  const plugin = discovery.byHost.get(hosts.selected);
  if (!plugin) {
    return { response: unclaimedHost(request, discovery, hosts.selected, host), plugin: null };
  }
  const identity = { name: plugin.metadata.name, version: plugin.metadata.version };
  const refusal = refuseBeforeRun(request, plugin.metadata);
  if (refusal) return { response: errorResponse(request, refusal), plugin: identity };
  const credential: OperationCredential =
    request.op === 'resolve'
      ? { kind: 'none' }
      : await pluginCredential(plugin, discovery, hosts.selected, options);
  if (credential.kind === 'failed' || credential.kind === 'missing') {
    return { response: errorResponse(request, credentialFailure(credential)), plugin: identity };
  }
  const selected = credential.kind === 'selected' ? credential : undefined;
  const run = (operation: ForgeRequest): Promise<ForgeResponse> =>
    runOperation(operation, plugin, selected?.token, hosts, options);
  // A mutation runs once: a temporary failure can arrive after the forge applied it.
  const outcome = isMutationRequest(request)
    ? { response: await run(request) }
    : await retryRead(request, run, options.sleep ?? Bun.sleep);
  return {
    ...outcome,
    plugin: identity,
    credentialSource: selected?.source,
  };
}

/** The waits before each repeat of a read; their count is the number of repeats. */
const READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Run a read, repeating it from its start while it fails with a temporary kind. A read
 * changes nothing, so a repeat is safe. The request type excludes every mutation, so a
 * write cannot be passed here.
 */
async function retryRead(
  read: Exclude<ForgeRequest, ForgeMutationRequest>,
  run: (read: Exclude<ForgeRequest, ForgeMutationRequest>) => Promise<ForgeResponse>,
  sleep: (ms: number) => Promise<unknown>
): Promise<{ response: ForgeResponse; retries: number }> {
  for (let retries = 0; ; retries++) {
    const response = await run(read);
    const delay = READ_RETRY_DELAYS_MS[retries];
    const temporary =
      !response.ok && temporaryErrorKinds.some(kind => kind === response.error.kind);
    if (!temporary || delay === undefined) return { response, retries };
    await sleep(delay);
  }
}

/** A failure names its operation and subject, so its reader knows what it was about. */
function named(request: ForgeRequest, response: ForgeResponse, retries: number): ForgeResponse {
  if (response.ok) return response;
  const target = requestTarget(request);
  const repo = target && ('repo' in target ? target.repo : target);
  const subject = repo
    ? ` on ${repo.host}/${repo.path}${target && 'number' in target ? `#${String(target.number)}` : ''}`
    : '';
  const repeated = retries > 0 ? `, retried ${String(retries)} times` : '';
  return {
    ...response,
    error: {
      ...response.error,
      message: `${response.error.message} (${request.op}${subject}${repeated})`,
    },
  };
}

function noForge(request: ForgeRequest): ForgeResponse {
  return {
    operationId: request.operationId,
    ok: true,
    result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
  };
}

function unclaimedHost(
  request: ForgeRequest,
  discovery: PluginDiscovery,
  selectedHost: string,
  host: string | undefined
): ForgeResponse {
  if (discovery.unavailable.length > 0) {
    return errorResponse(request, {
      kind: 'process_failed',
      message: `forge discovery could not resolve ${selectedHost}: ${discovery.unavailable.map(error => error.message).join('; ')}`,
    });
  }
  if (request.op === 'resolve') return noForge(request);
  return errorResponse(request, {
    kind: 'no_plugin_for_host',
    message: `no forge plugin claims ${host}`,
  });
}

/** What the plugin's own metadata refuses, decided before any process runs. */
function refuseBeforeRun(request: ForgeRequest, metadata: PluginMetadata): ForgeError | undefined {
  if (!metadata.capabilities.includes(request.op)) {
    return {
      kind: 'unsupported_op',
      message: `plugin ${metadata.name} does not support ${request.op}`,
    };
  }
  if (
    request.op === 'resolve' &&
    request.web === true &&
    !metadata.capabilities.includes(RESOLVE_SUBJECT)
  ) {
    return {
      kind: 'unsupported_op',
      message: `plugin ${metadata.name} does not resolve an issue or pull request URL`,
    };
  }
  if (
    request.op === 'pr.view' &&
    request.selector.kind === 'head' &&
    request.selector.state === 'any' &&
    !metadata.capabilities.includes(PR_VIEW_ANY_STATE)
  ) {
    return {
      kind: 'unsupported_op',
      message: `plugin ${metadata.name} does not support pr.view of a head in any state`,
    };
  }
  if (request.op !== 'pr.merge') return undefined;
  if (!request.conditions.head) {
    return { kind: 'invalid_request', message: 'A merge requires the approved head condition' };
  }
  const enforced = metadata.mutationConditions?.['pr.merge'];
  if (
    Object.keys(request.conditions).some(key => !enforced?.some(condition => condition === key))
  ) {
    return {
      kind: 'unsupported_op',
      message: 'Plugin does not enforce the requested merge conditions',
    };
  }
  return undefined;
}

function pluginCredential(
  plugin: DiscoveredPlugin,
  discovery: PluginDiscovery,
  selectedHost: string,
  options: DispatchOptions
): Promise<OperationCredential> {
  const env = options.env ?? process.env;
  const { names, github } = credentialEnvNames(plugin, discovery, selectedHost);
  return selectCredential(names, github, selectedHost, options.credentialEnv ?? env, env);
}

/**
 * The environment variables a plugin's credential is read from: a `token_env` configured
 * under `forge.hosts` or `forge.plugins` replaces the plugin's own list.
 */
function credentialEnvNames(
  plugin: DiscoveredPlugin,
  discovery: PluginDiscovery,
  selectedHost: string
): { names: readonly string[]; override?: string; github: boolean } {
  const metadata = plugin.metadata;
  const override =
    discovery.hostConfig.get(selectedHost)?.token_env ??
    discovery.pluginTokenEnv.get(metadata.name);
  if (override) return { names: [override], override, github: false };
  const github =
    metadata.forge === 'github' &&
    metadata.token_env.length > 0 &&
    metadata.token_env.every(name => GH_DOTCOM_TOKEN_KEYS.some(key => key === name));
  return { names: github ? GH_DOTCOM_TOKEN_KEYS : metadata.token_env, github };
}

function credentialFailure(
  credential: Extract<OperationCredential, { kind: 'missing' | 'failed' }>
): ForgeError {
  return {
    kind: credential.kind === 'failed' ? 'process_failed' : 'no_credential',
    message: credential.message,
  };
}

/** The one discovery every dispatch and preflight path runs, so they load the same plugins. */
function discover(options: DispatchOptions): Promise<PluginDiscovery> | PluginDiscovery {
  return (
    options.discovery ??
    discoverPlugins({
      config: options.config,
      env: options.env,
      pluginsDir: options.pluginsDir,
      sourcePlugins: options.sourcePlugins,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    })
  );
}

/** What a preflight learns about one forge: the plugin that serves it, or why a run cannot use it. */
export type ForgeAccessCheck =
  | {
      ok: true;
      host: string;
      plugin: NonNullable<ForgeDispatchResult['plugin']>;
      credentialSource?: string;
      /** Whether the credential read the repository; see {@link checkForgeAccess}. */
      read: boolean;
    }
  | { ok: false; error: ForgeError; unsupported?: string[]; remedy?: string };

/**
 * A head no pull request uses: the read asks for its pull request, which the forge answers
 * with none when the credential may read the repository.
 */
const ACCESS_READ_HEAD = 'archon-forge-check';

/**
 * Whether a forge operation could start: a plugin claims the forge, it advertises every
 * capability in `operations`, its credential resolves, and the forge accepts that
 * credential for the repository. The forge is `host`, `repo`'s host, or the plugin a
 * `resolve` of `remote` selects. A `remote` or `repo` check then makes one read, a `pr.view`
 * by head (after a `resolve` of a remote to its repository), so a rejected or blind
 * credential is refused. A `host` check names no repository and runs no plugin operation.
 * No check proves what the credential may write. A refusal the operator can fix carries
 * their next step.
 */
export async function checkForgeAccess(
  request: { host?: string; remote?: string; repo?: RepoRef; operations: readonly string[] },
  options: DispatchOptions = {}
): Promise<ForgeAccessCheck> {
  const own = accessHost(request);
  if (!own) {
    // The remote is not echoed: its URL can carry a credential in its userinfo.
    return refused({ kind: 'no_plugin_for_host', message: 'the remote names no forge host' });
  }
  let discovery: PluginDiscovery;
  try {
    discovery = await discover(options);
  } catch (error) {
    return { ok: false, error: discoveryFailure(error) };
  }
  const host = accessClaim(discovery, request, own);
  const plugin = discovery.byHost.get(host);
  if (!plugin) {
    const unavailable = discovery.unavailable.map(error => error.message).join('; ');
    return unavailable
      ? {
          ok: false,
          error: {
            kind: 'process_failed',
            message: `forge discovery could not resolve ${host}: ${unavailable}`,
          },
        }
      : refused({ kind: 'no_plugin_for_host', message: `no forge plugin claims ${host}` });
  }
  const { name, version, capabilities } = plugin.metadata;
  const unsupported = request.operations.filter(operation => !capabilities.includes(operation));
  if (unsupported.length > 0) {
    return {
      ...refused(
        {
          kind: 'unsupported_op',
          message: `plugin ${name} ${version} does not support ${unsupported.join(', ')}`,
        },
        plugin.metadata
      ),
      unsupported,
    };
  }
  const credential = await pluginCredential(plugin, discovery, host, options);
  if (credential.kind === 'failed') return { ok: false, error: credentialFailure(credential) };
  if (credential.kind === 'missing') {
    return refused(
      { kind: 'no_credential', message: credential.message },
      plugin.metadata,
      credentialEnvNames(plugin, discovery, host).override
    );
  }
  const passed = {
    ok: true as const,
    host,
    plugin: { name, version },
    ...(credential.kind === 'selected' ? { credentialSource: credential.source } : {}),
    read: false,
  };
  // A `host` check names no repository, and a plugin without `pr.view` has no read to
  // serve: both stop at the credential, and say so with `read: false`.
  if (request.host !== undefined || !capabilities.includes('pr.view')) return passed;
  return readRepository(request, passed, { ...options, discovery });
}

/**
 * The check's one read: a `pr.view` by head of the repository, which a `remote` names
 * through a `resolve`. The forge's own read path runs it, so its retries and response
 * checks are those of every forge read.
 */
async function readRepository(
  request: { remote?: string; repo?: RepoRef },
  passed: Extract<ForgeAccessCheck, { ok: true }>,
  options: DispatchOptions
): Promise<ForgeAccessCheck> {
  let repo = request.repo;
  if (repo === undefined) {
    const { response } = await dispatch(
      { operationId: crypto.randomUUID(), op: 'resolve', remote: request.remote ?? null },
      options
    );
    if (!response.ok) return { ok: false, error: response.error };
    if (response.result.op !== 'resolve' || response.result.value.kind !== 'resolved') {
      return refused({
        kind: 'no_plugin_for_host',
        message: 'the remote names no forge repository',
      });
    }
    repo = response.result.value.repo;
  }
  const read: ForgeRequest = {
    operationId: crypto.randomUUID(),
    op: 'pr.view',
    selector: { kind: 'head', repo, headRepo: repo, head: ACCESS_READ_HEAD },
  };
  const { response, retries = 0 } = await dispatch(read, options);
  const answer = named(read, response, retries);
  if (answer.ok) return { ...passed, read: true };
  const { error } = answer;
  if (error.kind === 'authorization') {
    const source = passed.credentialSource ? ` from ${passed.credentialSource}` : '';
    return {
      ok: false,
      error,
      remedy: `The forge rejected the credential${source}: replace or refresh it, or connect your GitHub identity again when per-user GitHub is on.`,
    };
  }
  if (error.kind === 'not_found') {
    return {
      ok: false,
      error,
      remedy: `The credential cannot see ${repo.host}/${repo.path}, or the repository does not exist: check the repository and the credential's access to it.`,
    };
  }
  return { ok: false, error };
}

/** The forge's own host for a check, as `dispatch` reads it for the same remote or repository. */
function accessHost(request: {
  host?: string;
  remote?: string;
  repo?: RepoRef;
}): string | undefined {
  if (request.remote !== undefined) return remoteHost(request.remote);
  return normalizeHost(request.repo?.host ?? request.host ?? '') || undefined;
}

/** The claim whose plugin a check selects, as `selectHost` selects it for a dispatch. */
function accessClaim(
  discovery: PluginDiscovery,
  request: { remote?: string; repo?: RepoRef },
  own: string
): string {
  if (request.remote !== undefined) return remotePluginHost(discovery, request.remote, own);
  return request.repo?.hostClaim ? own.slice(0, -4) : own;
}

type PreReadRefusalKind = Exclude<ForgeAccessRefusalKind, 'authorization' | 'not_found'>;

/** A refusal the operator fixes, with their next step: the plugin's text, else forge's. */
function refused(
  error: ForgeError & { kind: PreReadRefusalKind },
  metadata?: PluginMetadata,
  tokenEnvOverride?: string
): Extract<ForgeAccessCheck, { ok: false }> {
  return { ok: false, error, remedy: remedy(error.kind, metadata, tokenEnvOverride) };
}

function remedy(
  kind: PreReadRefusalKind,
  metadata: PluginMetadata | undefined,
  tokenEnvOverride: string | undefined
): string {
  if (kind === 'no_plugin_for_host' || metadata === undefined) {
    return "Install a forge plugin that claims this host with `archon plugin add`, or map the host to an installed plugin under `forge.hosts` in Archon's config.";
  }
  // The plugin's own text names the variables it declares, which a configured token_env replaces.
  if (kind === 'no_credential' && tokenEnvOverride) {
    return `Set ${tokenEnvOverride}, the token_env Archon's config names for plugin ${metadata.name}, in Archon's env file or the run's environment.`;
  }
  const own = metadata.remedies?.[kind];
  if (own) return own;
  return kind === 'unsupported_op'
    ? `Update plugin ${metadata.name} (installed ${metadata.version}) with \`archon plugin update\`; \`archon plugin list\` shows what is installed.`
    : `Supply the credential plugin ${metadata.name} reads${metadata.token_env.length > 0 ? ` (${metadata.token_env.join(', ')})` : ''} in Archon's env file or the run's environment.`;
}

async function runOperation(
  request: ForgeRequest,
  plugin: DiscoveredPlugin,
  token: string | undefined,
  hosts: DispatchHosts,
  options: DispatchOptions
): Promise<ForgeResponse> {
  const outcome = await runPluginProcess(plugin, ['op', request.op], {
    env: options.env ?? process.env,
    forge: plugin.metadata.forge,
    stdin: JSON.stringify(request),
    token,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal,
  });
  // Once the plugin process started, a lost result is a lost mutation outcome.
  const lost = outcome.launched ? 'outcome_unknown' : 'refused';
  const failure = processFailure(outcome);
  if (failure) return errorResponse(request, failure, lost);
  const response = pluginResponse(outcome.stdout);
  if (
    !response ||
    response.operationId !== request.operationId ||
    response.ok !== (outcome.exitCode === 0) ||
    !matchesForgeOperationResponse(request, response, plugin.metadata, hosts.repository)
  ) {
    return errorResponse(
      request,
      { kind: 'invalid_response', message: 'forge plugin returned an invalid response' },
      lost
    );
  }
  return retainHostClaim(response, hosts.repository, hosts.selected);
}

function processFailure(outcome: PluginProcessResult): ForgeError | undefined {
  if (outcome.timedOut) return { kind: 'timeout', message: 'forge plugin timed out' };
  if (outcome.outputExceeded) {
    return { kind: 'process_failed', message: 'forge plugin output exceeded 16 MiB' };
  }
  if (outcome.spawnError || outcome.terminationError || ![0, 1].includes(outcome.exitCode ?? -1)) {
    return {
      kind: 'process_failed',
      message:
        outcome.spawnError ??
        outcome.terminationError ??
        `forge plugin exited ${String(outcome.exitCode)}: ${outcome.stderr.slice(0, 1000)}`,
      exitCode: outcome.exitCode,
    };
  }
  return undefined;
}

function pluginResponse(stdout: string): ForgeResponse | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    raw = undefined;
  }
  const parsed = forgeResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function finish(
  request: ForgeRequest,
  plugin: ForgeDispatchResult['plugin'],
  response: ForgeResponse,
  retries: number,
  started: number
): ForgeDispatchResult {
  const audit = forgeOperationAuditSchema.parse({
    operationId: request.operationId,
    operation: request.op,
    target: requestTarget(request, response),
    plugin,
    result: forgeAuditResponse(response),
    retries,
    durationMs: Math.max(0, performance.now() - started),
  });
  return { response, plugin, audit };
}
