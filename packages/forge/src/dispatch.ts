import { z } from 'zod';
import {
  forgeAuditResponse,
  forgeOperationAuditSchema,
  forgeRequestSchema,
  forgeResponseSchema,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
  type ForgeError,
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
} from './discovery';
import { normalizeHost, type ForgePluginConfig } from './plugin-config';
import { runPluginProcess, type PluginProcessResult } from './plugin-process';
import { selectCredential } from './credentials';
import { GH_DOTCOM_TOKEN_KEYS } from '@archon/paths/github-token-env';
import { parseRemoteUrl } from './remote-url';
import { httpsDefaultPortHost, matchesForgeOperationResponse } from './response-match';

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
  if (!discovery.byHost.has(host)) return httpsDefaultPortHost(request) ?? host;
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

function discoveryError(request: ForgeRequest, error: unknown): ForgeResponse {
  if (error instanceof PluginDiscoveryError) {
    return errorResponse(request, { kind: error.kind, message: error.message });
  }
  return errorResponse(request, {
    kind: 'process_failed',
    message: 'forge plugin discovery failed',
  });
}

interface DispatchOptions {
  config?: ForgePluginConfig;
  env?: NodeJS.ProcessEnv;
  credentialEnv?: NodeJS.ProcessEnv;
  discovery?: PluginDiscovery;
  /** Passed to `discoverPlugins`; the host owns where installed plugins live. */
  pluginsDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface Dispatched {
  response: ForgeResponse;
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
  const { response, plugin, credentialSource } = await dispatch(request, options);
  return {
    ...finish(request, plugin, response, started),
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
    discovery =
      options.discovery ??
      (await discoverPlugins({
        config: options.config,
        env: options.env,
        pluginsDir: options.pluginsDir,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      }));
  } catch (error) {
    return { response: discoveryError(request, error), plugin: null };
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
  const credential = await operationCredential(request, plugin, discovery, hosts.selected, options);
  if (credential.kind === 'failed' || credential.kind === 'missing') {
    return {
      response: errorResponse(request, {
        kind: credential.kind === 'failed' ? 'process_failed' : 'no_credential',
        message: credential.message,
      }),
      plugin: identity,
    };
  }
  const selected = credential.kind === 'selected' ? credential : undefined;
  return {
    response: await runOperation(request, plugin, selected?.token, hosts, options),
    plugin: identity,
    credentialSource: selected?.source,
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

function operationCredential(
  request: ForgeRequest,
  plugin: DiscoveredPlugin,
  discovery: PluginDiscovery,
  selectedHost: string,
  options: DispatchOptions
): Promise<OperationCredential> {
  if (request.op === 'resolve') return Promise.resolve({ kind: 'none' });
  const env = options.env ?? process.env;
  const metadata = plugin.metadata;
  const override =
    discovery.hostConfig.get(selectedHost)?.token_env ??
    discovery.pluginTokenEnv.get(metadata.name);
  const github =
    metadata.forge === 'github' &&
    !override &&
    metadata.token_env.length > 0 &&
    metadata.token_env.every(name => GH_DOTCOM_TOKEN_KEYS.some(key => key === name));
  const names = override ? [override] : github ? GH_DOTCOM_TOKEN_KEYS : metadata.token_env;
  return selectCredential(names, github, selectedHost, options.credentialEnv ?? env, env);
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
  started: number
): ForgeDispatchResult {
  const audit = forgeOperationAuditSchema.parse({
    operationId: request.operationId,
    operation: request.op,
    target: requestTarget(request, response),
    plugin,
    result: forgeAuditResponse(response),
    durationMs: Math.max(0, performance.now() - started),
  });
  return { response, plugin, audit };
}
