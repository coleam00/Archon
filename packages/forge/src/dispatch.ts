import { z } from 'zod';
import {
  contentDigest,
  forgeAuditResponse,
  forgeOperationAuditSchema,
  forgeRequestSchema,
  forgeResponseSchema,
  isMutationRequest,
  mutationTarget,
  type ForgeError,
  type ForgeMutationTarget,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';
import type { PrRef, RepoRef } from './identity';
import {
  discoverPlugins,
  PluginDiscoveryError,
  type DiscoveredPlugin,
  type PluginDiscovery,
} from './discovery';
import { normalizeHost, type ForgePluginConfig } from './plugin-config';
import { runPluginProcess } from './plugin-process';

export type ForgeOperationAudit = z.infer<typeof forgeOperationAuditSchema>;
export interface ForgeDispatchResult {
  response: ForgeResponse;
  plugin: Pick<PluginMetadata, 'name' | 'version'> | null;
  audit: ForgeOperationAudit;
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
      ? { mutation: { op: request.op, target: mutationTarget(request), outcome } }
      : {}),
  };
}

/**
 * Repository identity, compared the way a forge registers it.
 *
 * Host and owner/name are case-insensitive but case-preserving: a forge echoes
 * back the case it has registered, whatever case the request carried. An exact
 * comparison would read a write that landed exactly as asked as one that did not.
 */
function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    normalizeHost(left.host) === normalizeHost(right.host) &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}
function sameRef(left: PrRef, right: PrRef): boolean {
  return sameRepo(left.repo, right.repo) && left.number === right.number;
}
function sameTarget(left: ForgeMutationTarget, right: ForgeMutationTarget): boolean {
  return 'repo' in left
    ? 'repo' in right && sameRef(left, right)
    : !('repo' in right) && sameRepo(left, right);
}

function requestRepo(request: Exclude<ForgeRequest, { op: 'resolve' }>): RepoRef {
  if (request.op === 'pr.create') return request.repo;
  if (request.op === 'pr.view')
    return request.selector.kind === 'head' ? request.selector.repo : request.selector.ref.repo;
  return request.ref.repo;
}

function requestTarget(
  request: ForgeRequest,
  response?: ForgeResponse
): ForgeOperationAudit['target'] {
  if (request.op === 'pr.create') return request.repo;
  if (request.op === 'pr.view')
    return request.selector.kind === 'head' ? request.selector.repo : request.selector.ref;
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
    const url = new URL(remote);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    return normalizeHost(url.host);
  } catch {
    return undefined;
  }
}

/**
 * Whether a plugin's response answers the request that was sent.
 *
 * A mutation's applied result is checked against what was asked rather than
 * trusted: the plugin claims it read the write back, and this is where that claim
 * meets the request. A failed mutation must carry its own outcome evidence — a
 * plugin that omits it has not said whether anything was written, and the caller
 * gets `outcome_unknown` instead of a refusal it did not earn.
 */
export function matchesForgeOperationResponse(
  request: ForgeRequest,
  response: ForgeResponse,
  metadata: PluginMetadata,
  host: string
): boolean {
  if (!response.ok) {
    if (!isMutationRequest(request)) return response.mutation === undefined;
    const evidence = response.mutation;
    if (evidence?.op !== request.op) return false;
    if (!sameTarget(evidence.target, mutationTarget(request))) return false;
    return (
      !('observed' in evidence) ||
      !evidence.observed ||
      (request.op === 'pr.create'
        ? sameRepo(evidence.observed.repo, request.repo)
        : sameRef(evidence.observed, request.ref))
    );
  }
  const result = response.result;
  if (result.op !== request.op) return false;
  switch (result.op) {
    case 'resolve': {
      const value = result.value;
      return (
        value.kind === 'none' ||
        (normalizeHost(value.repo.host) === host &&
          value.forge === metadata.forge &&
          value.plugin.name === metadata.name &&
          value.plugin.version === metadata.version)
      );
    }
    case 'checks.state':
      return request.op === result.op && sameRef(result.value.ref, request.ref);
    case 'workitem.view':
      return request.op === result.op && sameRef(result.value.ref, request.ref);
    case 'pr.view': {
      if (request.op !== result.op) return false;
      const value = result.value;
      // Only a head selector may find nothing; an explicit number must resolve.
      if (!value) return request.selector.kind === 'head';
      const selector = request.selector;
      return selector.kind === 'number'
        ? sameRef(value.pr, selector.ref)
        : // A head selector asks for the branch's open pull request, never a closed one.
          value.pr.state === 'open' &&
            sameRepo(value.pr.repo, selector.repo) &&
            value.pr.head === selector.head &&
            value.pr.head_repo !== null &&
            sameRepo(value.pr.head_repo, selector.headRepo) &&
            (selector.base === undefined || value.pr.base === selector.base);
    }
    case 'comment.upsert':
      return (
        request.op === result.op &&
        sameTarget(result.value.target, mutationTarget(request)) &&
        sameRef(result.value.comment.ref, request.ref) &&
        result.value.comment.bodyDigest === contentDigest(request.body)
      );
    case 'pr.create':
      return (
        request.op === result.op &&
        sameTarget(result.value.target, mutationTarget(request)) &&
        sameRepo(result.value.pr.repo, request.repo) &&
        result.value.pr.head_repo !== null &&
        sameRepo(result.value.pr.head_repo, request.headRepo) &&
        result.value.pr.head === request.head &&
        result.value.pr.base === request.base &&
        result.value.pr.head_revision === request.headRevision &&
        result.value.pr.is_draft === request.draft &&
        result.value.pr.state === 'open'
      );
    case 'pr.edit-body':
      return (
        request.op === result.op &&
        sameTarget(result.value.target, mutationTarget(request)) &&
        sameRef(result.value.pr, request.ref) &&
        result.value.bodyDigest === contentDigest(request.body)
      );
    case 'pr.ready':
      return (
        request.op === result.op &&
        sameTarget(result.value.target, mutationTarget(request)) &&
        sameRef(result.value.pr, request.ref) &&
        result.value.pr.state === 'open' &&
        !result.value.pr.is_draft
      );
  }
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

function selectedCredential(
  discovery: PluginDiscovery,
  plugin: DiscoveredPlugin,
  host: string,
  env: NodeJS.ProcessEnv
): { token?: string; missing?: string } {
  const override = discovery.hostConfig.get(host)?.token_env;
  const configured = discovery.pluginTokenEnv.get(plugin.metadata.name);
  const names = override ? [override] : configured ? [configured] : plugin.metadata.token_env;
  if (names.length === 0) return {};
  for (const name of names) if (env[name]) return { token: env[name] };
  return { missing: names.join(' or ') };
}

export async function dispatchForge(
  input: ForgeRequest,
  options: {
    config?: ForgePluginConfig;
    env?: NodeJS.ProcessEnv;
    credentialEnv?: NodeJS.ProcessEnv;
    discovery?: PluginDiscovery;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ForgeDispatchResult> {
  const started = performance.now();
  const request = forgeRequestSchema.parse(input);
  let pluginIdentity: ForgeDispatchResult['plugin'] = null;
  let response: ForgeResponse;

  const host =
    request.op === 'resolve'
      ? remoteHost(request.remote)
      : normalizeHost(requestRepo(request).host);
  if (request.op === 'resolve' && !host) {
    response = {
      operationId: request.operationId,
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    };
  } else {
    let discovery: PluginDiscovery;
    try {
      discovery =
        options.discovery ??
        (await discoverPlugins({
          config: options.config,
          env: options.env,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        }));
    } catch (error) {
      response = discoveryError(request, error);
      return finish(request, pluginIdentity, response, started);
    }
    const selectedHost = host ?? '';
    const plugin = discovery.byHost.get(selectedHost);
    if (!plugin) {
      response =
        discovery.unavailable.length > 0
          ? errorResponse(request, {
              kind: 'process_failed',
              message: `forge discovery could not resolve ${selectedHost}: ${discovery.unavailable.map(error => error.message).join('; ')}`,
            })
          : request.op === 'resolve'
            ? {
                operationId: request.operationId,
                ok: true,
                result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
              }
            : errorResponse(request, {
                kind: 'no_plugin_for_host',
                message: `no forge plugin claims ${host}`,
              });
    } else {
      pluginIdentity = { name: plugin.metadata.name, version: plugin.metadata.version };
      if (!plugin.metadata.capabilities.includes(request.op)) {
        response = errorResponse(request, {
          kind: 'unsupported_op',
          message: `plugin ${plugin.metadata.name} does not support ${request.op}`,
        });
      } else {
        const env = options.env ?? process.env;
        const credential = selectedCredential(
          discovery,
          plugin,
          selectedHost,
          options.credentialEnv ?? env
        );
        if (credential.missing && request.op !== 'resolve') {
          response = errorResponse(request, {
            kind: 'no_credential',
            message: `credential environment ${credential.missing} is not set`,
          });
        } else {
          const outcome = await runPluginProcess(plugin, ['op', request.op], {
            env,
            stdin: JSON.stringify(request),
            token: credential.token,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
            signal: options.signal,
          });
          // Once the plugin process started, a lost result is a lost mutation outcome.
          const lost = outcome.launched ? 'outcome_unknown' : 'refused';
          if (outcome.timedOut)
            response = errorResponse(
              request,
              { kind: 'timeout', message: 'forge plugin timed out' },
              lost
            );
          else if (outcome.outputExceeded)
            response = errorResponse(
              request,
              { kind: 'process_failed', message: 'forge plugin output exceeded 16 MiB' },
              lost
            );
          else if (
            outcome.spawnError ||
            outcome.terminationError ||
            ![0, 1].includes(outcome.exitCode ?? -1)
          ) {
            response = errorResponse(
              request,
              {
                kind: 'process_failed',
                message:
                  outcome.spawnError ??
                  outcome.terminationError ??
                  `forge plugin exited ${String(outcome.exitCode)}: ${outcome.stderr.slice(0, 1000)}`,
                exitCode: outcome.exitCode,
              },
              lost
            );
          } else {
            let raw: unknown;
            try {
              raw = JSON.parse(outcome.stdout) as unknown;
            } catch {
              raw = undefined;
            }
            const parsed = forgeResponseSchema.safeParse(raw);
            if (
              !parsed.success ||
              parsed.data.operationId !== request.operationId ||
              parsed.data.ok !== (outcome.exitCode === 0) ||
              !matchesForgeOperationResponse(request, parsed.data, plugin.metadata, selectedHost)
            ) {
              response = errorResponse(
                request,
                {
                  kind: 'invalid_response',
                  message: 'forge plugin returned an invalid response',
                },
                lost
              );
            } else response = parsed.data;
          }
        }
      }
    }
  }
  return finish(request, pluginIdentity, response, started);
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
