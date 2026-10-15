import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import { getPluginsPath } from '@archon/paths';
import { discoverPlugins } from '@archon/forge/discovery';
import { dispatchForge, type ForgeOperationAudit } from '@archon/forge/dispatch';
import { forgePluginConfigSchema } from '@archon/forge/plugin-config';
import {
  forgeRequestSchema,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import { writeJsonLine } from '../utils/stdout';

async function readForgeConfig(configPath: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config: unknown = Bun.YAML.parse(source);
  if (config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config))
    throw new Error('Archon config must be an object');
  return 'forge' in config ? config.forge : {};
}

async function persistAudit(audit: ForgeOperationAudit, runId: string): Promise<void> {
  const { persistWorkflowEvent } = await import('@archon/core/db/workflow-events');
  const { closeDatabase } = await import('@archon/core/db/connection');
  try {
    await persistWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'integration_operation',
      data: { integration: 'forge', ...audit },
    });
  } finally {
    await closeDatabase();
  }
}

export async function forgeCommand(
  subcommand: string | undefined,
  options: {
    data?: string;
    dataFile?: string;
    configPath?: string;
    trustedEnv?: NodeJS.ProcessEnv;
  },
  dependencies: {
    dispatch?: typeof dispatchForge;
    readConfig?: () => Promise<unknown>;
    audit?: typeof persistAudit;
    write?: typeof writeJsonLine;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<number> {
  const write = dependencies.write ?? writeJsonLine;
  const env = dependencies.env ?? process.env;
  const trustedEnv = options.trustedEnv ?? env;
  const operationId = randomUUID();
  let response: ForgeResponse;
  let request: ForgeRequest | undefined;
  let dispatched = false;
  try {
    // Config and plugin discovery resolve from the same trusted environment the plugin
    // runs in, never from this process's ambient env.
    const archonHome = getArchonHome(trustedEnv);
    const op = subcommand === 'checks' ? 'checks.state' : subcommand;
    if (options.data !== undefined && options.dataFile !== undefined) {
      throw new Error('Supply the request through --data or --data-file, not both');
    }
    // Authored content — a pull-request body, a review comment — reaches the
    // operation through a file so it never appears in this process's argv.
    const source =
      options.dataFile !== undefined ? await readFile(options.dataFile, 'utf8') : options.data;
    const supplied: unknown = source !== undefined ? JSON.parse(source) : {};
    if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
      throw new Error('--data must be a JSON object');
    }
    const config = forgePluginConfigSchema.parse(
      dependencies.readConfig
        ? await dependencies.readConfig()
        : await readForgeConfig(options.configPath ?? getArchonConfigPath(archonHome))
    );
    // Host introspection reads the same trusted discovery metadata as dispatch;
    // it is not a plugin operation and never resolves a credential.
    if (op === 'metadata') {
      if (!('host' in supplied) || typeof supplied.host !== 'string' || !supplied.host.trim())
        throw new Error('metadata requires a host');
      const discovery = await discoverPlugins({
        config,
        env: trustedEnv,
        pluginsDir: getPluginsPath(archonHome),
      });
      const plugin = discovery.byHost.get(supplied.host.trim().toLowerCase());
      if (plugin) {
        await write({ operationId, ok: true, result: { op: 'metadata', value: plugin.metadata } });
        return 0;
      }
      await write({
        operationId,
        ok: false,
        error: {
          kind: discovery.unavailable.length ? 'process_failed' : 'no_plugin_for_host',
          message: discovery.unavailable.length
            ? discovery.unavailable.map(error => error.message).join('; ')
            : `no forge plugin claims ${supplied.host}`,
        },
      });
      return 1;
    }
    request = forgeRequestSchema.parse({ ...supplied, operationId, op });
    dispatched = true;
    const result = await (dependencies.dispatch ?? dispatchForge)(request, {
      config,
      env: trustedEnv,
      // The trusted directory `archon plugin add` writes; repo env cannot move it.
      pluginsDir: getPluginsPath(archonHome),
      // Repo scope may supply the credential named by trusted user config. It
      // cannot replace executable discovery or the plugin's runtime identity.
      credentialEnv: env,
    });
    response = result.response;
    if (env.WORKFLOW_ID) {
      try {
        await (dependencies.audit ?? persistAudit)(result.audit, env.WORKFLOW_ID);
      } catch {
        // Retain the actual operation outcome on stdout. Audit failure is a
        // separate failure and never rewrites an observed result as a refusal.
        await write(response);
        process.stderr.write(
          `Forge operation ${operationId} completed but its run audit could not be persisted.\n`
        );
        return 2;
      }
    }
  } catch (error) {
    // Once dispatch has begun, this process can no longer claim the request was
    // refused: a mutation may already have reached the forge.
    response = {
      operationId,
      ok: false,
      error: {
        kind: dispatched ? 'process_failed' : 'invalid_request',
        message: dispatched
          ? 'Forge dispatch failed; reconcile the operation before retrying it'
          : error instanceof SyntaxError
            ? 'Invalid JSON input or configuration'
            : 'Invalid forge request or configuration; see archon forge --help',
      },
      ...(request && isMutationRequest(request)
        ? {
            mutation: {
              op: request.op,
              target: mutationTarget(request),
              ...mutationAttempt(request),
              outcome: dispatched ? ('outcome_unknown' as const) : ('refused' as const),
            },
          }
        : {}),
    };
  }
  await write(response);
  return response.ok ? 0 : 1;
}
