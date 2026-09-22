import { createHash } from 'node:crypto';
import type { RepoRef, PrRef } from './identity';
import { z } from 'zod';
import {
  forgeOperationAuditSchema,
  forgeAuditResponse,
  isMutationRequest,
  mutationEvidence,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  forgeRequestSchema,
  forgeResponseSchema,
  type ForgeError,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
} from './operations';
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
      ? { mutation: { ...mutationEvidence(request), op: request.op, outcome } }
      : {}),
  };
}
function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.host === b.host && a.path === b.path;
}
function sameRef(a: PrRef, b: PrRef): boolean {
  return sameRepo(a.repo, b.repo) && a.number === b.number;
}
function sameTarget(a: RepoRef | PrRef, b: RepoRef | PrRef): boolean {
  return 'repo' in a ? 'repo' in b && sameRef(a, b) : !('repo' in b) && sameRepo(a, b);
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

export function matchesForgeOperationResponse(
  request: ForgeRequest,
  response: ForgeResponse,
  metadata: PluginMetadata,
  host: string
): boolean {
  if (!response.ok) {
    if (!isMutationRequest(request)) return response.mutation === undefined;
    const value = response.mutation;
    if (value?.op !== request.op || !sameTarget(value.target, mutationEvidence(request).target))
      return false;
    if (!matchesConditions(request, value, metadata, false)) return false;
    return (
      !value.observed ||
      (request.op === 'pr.create'
        ? sameRepo(value.observed.repo, request.repo)
        : sameRef(value.observed, request.ref))
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
      if (!value) return request.selector.kind === 'head';
      const selector = request.selector;
      return selector.kind === 'number'
        ? sameRef(value.pr, selector.ref)
        : sameRepo(value.pr.repo, selector.repo) &&
            value.pr.head === selector.head &&
            value.pr.head_repo !== null &&
            sameRepo(value.pr.head_repo, selector.headRepo) &&
            (!selector.base || value.pr.base === selector.base);
    }
    default: {
      if (!isMutationRequest(request)) return false;
      const value = result.value;
      if (
        !sameTarget(value.target, mutationEvidence(request).target) ||
        !matchesConditions(request, value, metadata, true)
      )
        return false;
      if (result.op === 'comment.upsert')
        return (
          request.op === result.op &&
          sameRef(result.value.comment.ref, request.ref) &&
          result.value.comment.bodyDigest ===
            createHash('sha256').update(request.body).digest('hex')
        );
      const pr = result.value.pr;
      if (request.op === 'pr.create')
        return (
          result.op === request.op &&
          sameRepo(pr.repo, request.repo) &&
          pr.head_repo !== null &&
          sameRepo(pr.head_repo, request.headRepo) &&
          pr.head === request.head &&
          pr.base === request.base &&
          pr.head_revision === request.headRevision &&
          pr.is_draft === request.draft &&
          pr.state === 'open'
        );
      if (!sameRef(pr, request.ref)) return false;
      if (result.op === 'pr.ready') return pr.state === 'open' && !pr.is_draft;
      if (result.op === 'pr.edit-body')
        return (
          request.op === result.op &&
          result.value.bodyDigest === createHash('sha256').update(request.body).digest('hex')
        );
      if (result.op === 'pr.merge')
        return (
          request.op === result.op &&
          pr.state === 'merged' &&
          result.value.method === request.method
        );
      return false;
    }
  }
}

function matchesConditions(
  request: ForgeMutationRequest,
  value: Pick<ForgeMutationFailure, 'requested' | 'enforced'>,
  metadata: PluginMetadata,
  applied: boolean
): boolean {
  const required = mutationEvidence(request).requested;
  const keys = new Set([...Object.keys(required), ...Object.keys(value.requested)]);
  if ([...keys].some(key => Reflect.get(required, key) !== Reflect.get(value.requested, key)))
    return false;
  for (const [key, id] of Object.entries(value.enforced)) {
    if (
      id !== Reflect.get(required, key) ||
      !metadata.operations?.['pr.merge']?.atomicConditions.some(condition => condition === key)
    )
      return false;
  }
  return (
    !applied ||
    [...keys].every(key => Reflect.get(value.enforced, key) === Reflect.get(required, key))
  );
}

function unsupportedMerge(request: ForgeRequest, metadata: PluginMetadata): ForgeError | undefined {
  if (request.op !== 'pr.merge') return undefined;
  const capabilities = metadata.operations?.['pr.merge'];
  if (!capabilities?.methods.includes(request.method))
    return {
      kind: 'unsupported_op',
      message: 'plugin does not declare the requested merge method',
    };
  const unsupported = Object.keys(request.required).filter(
    key => !capabilities.atomicConditions.some(condition => condition === key)
  );
  if (unsupported.length)
    return {
      kind: 'unsupported_condition',
      message: `plugin cannot atomically enforce requested merge conditions: ${unsupported.join(', ')}`,
    };
  return undefined;
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
      const mergeError = unsupportedMerge(request, plugin.metadata);
      if (!plugin.metadata.capabilities.includes(request.op)) {
        response = errorResponse(request, {
          kind: 'unsupported_op',
          message: `plugin ${plugin.metadata.name} does not support ${request.op}`,
        });
      } else if (mergeError) {
        response = errorResponse(request, mergeError);
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
          const uncertainty = outcome.launched ? 'outcome_unknown' : 'refused';
          if (outcome.timedOut)
            response = errorResponse(
              request,
              {
                kind: 'timeout',
                message: 'forge plugin timed out',
              },
              uncertainty
            );
          else if (outcome.outputExceeded)
            response = errorResponse(
              request,
              {
                kind: 'process_failed',
                message: 'forge plugin output exceeded the configured output limit',
              },
              uncertainty
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
              uncertainty
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
                uncertainty
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
