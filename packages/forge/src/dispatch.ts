import { z } from 'zod';
import {
  forgeOperationAuditSchema,
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

function errorResponse(request: ForgeRequest, error: ForgeError): ForgeResponse {
  return { operationId: request.operationId, ok: false, error };
}

function requestTarget(
  request: ForgeRequest,
  response?: ForgeResponse
): ForgeOperationAudit['target'] {
  if (request.op === 'checks.state') return request.ref;
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

function matchesOperation(
  request: ForgeRequest,
  response: ForgeResponse,
  metadata: PluginMetadata,
  host: string
): boolean {
  if (!response.ok) return true;
  const result = response.result;
  if (result.op === 'checks.state') {
    return (
      request.op === 'checks.state' &&
      result.value.ref.number === request.ref.number &&
      result.value.ref.repo.host === request.ref.repo.host &&
      result.value.ref.repo.path === request.ref.repo.path
    );
  }
  if (request.op !== 'resolve') return false;
  const value = result.value;
  return (
    value.kind === 'none' ||
    (normalizeHost(value.repo.host) === host &&
      value.forge === metadata.forge &&
      value.plugin.name === metadata.name &&
      value.plugin.version === metadata.version)
  );
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
    request.op === 'resolve' ? remoteHost(request.remote) : normalizeHost(request.ref.repo.host);
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
          if (outcome.timedOut)
            response = errorResponse(request, {
              kind: 'timeout',
              message: 'forge plugin timed out',
            });
          else if (outcome.outputExceeded)
            response = errorResponse(request, {
              kind: 'process_failed',
              message: 'forge plugin output exceeded 16 MiB',
            });
          else if (
            outcome.spawnError ||
            outcome.terminationError ||
            ![0, 1].includes(outcome.exitCode ?? -1)
          ) {
            response = errorResponse(request, {
              kind: 'process_failed',
              message:
                outcome.spawnError ??
                outcome.terminationError ??
                `forge plugin exited ${String(outcome.exitCode)}: ${outcome.stderr.slice(0, 1000)}`,
              exitCode: outcome.exitCode,
            });
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
              !matchesOperation(request, parsed.data, plugin.metadata, selectedHost)
            ) {
              response = errorResponse(request, {
                kind: 'invalid_response',
                message: 'forge plugin returned an invalid response',
              });
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
    result: response,
    durationMs: Math.max(0, performance.now() - started),
  });
  return { response, plugin, audit };
}
