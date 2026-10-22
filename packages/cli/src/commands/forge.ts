import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import { getPluginsPath } from '@archon/paths';
import { discoverPlugins } from '@archon/forge/discovery';
import { dispatchForge, type ForgeOperationAudit } from '@archon/forge/dispatch';
import { type ForgePluginConfig, forgePluginConfigSchema } from '@archon/forge/plugin-config';
import {
  forgeRequestSchema,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
  type ForgeRequest,
} from '@archon/forge/operations';
import {
  cliForgeMetadataRequestSchema,
  cliForgeResponseSchema,
  type CliForgeResponse,
} from '@archon/forge';
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

interface ForgeCommandOptions {
  data?: string;
  dataFile?: string;
  configPath?: string;
  trustedEnv?: NodeJS.ProcessEnv;
}

interface ForgeCommandDependencies {
  dispatch?: typeof dispatchForge;
  readConfig?: () => Promise<unknown>;
  audit?: typeof persistAudit;
  write?: typeof writeJsonLine;
  env?: NodeJS.ProcessEnv;
}

/** What the failure response may claim depends on how far the operation got. */
interface ForgeAttempt {
  request?: ForgeRequest;
  dispatched: boolean;
  credentialSource?: string;
}

interface ForgeCommandContext {
  operationId: string;
  env: NodeJS.ProcessEnv;
  trustedEnv: NodeJS.ProcessEnv;
  write: (value: CliForgeResponse) => Promise<void>;
  dependencies: ForgeCommandDependencies;
  attempt: ForgeAttempt;
}

type ForgeDispatchResult = Awaited<ReturnType<typeof dispatchForge>>;

interface ForgeInput {
  archonHome: string;
  op: string | undefined;
  supplied: object;
  config: ForgePluginConfig;
}

export async function forgeCommand(
  subcommand: string | undefined,
  options: ForgeCommandOptions,
  dependencies: ForgeCommandDependencies = {}
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const context: ForgeCommandContext = {
    operationId: randomUUID(),
    env,
    trustedEnv: options.trustedEnv ?? env,
    write: (value: CliForgeResponse): Promise<void> =>
      (dependencies.write ?? writeJsonLine)(cliForgeResponseSchema.parse(value)),
    dependencies,
    attempt: { dispatched: false },
  };
  let response: CliForgeResponse;
  try {
    const input = await readForgeInput(subcommand, options, context);
    if (input.op === 'metadata') return await answerMetadata(input, context);
    const result = await dispatchRequest(input, context);
    response = result.response;
    const auditFailure = await auditOperation(result.audit, response, context);
    if (auditFailure !== undefined) return auditFailure;
  } catch (error) {
    response = failureResponse(error, context);
  }
  await writeResponse(response, context);
  return response.ok ? 0 : 1;
}

async function readForgeInput(
  subcommand: string | undefined,
  options: ForgeCommandOptions,
  context: ForgeCommandContext
): Promise<ForgeInput> {
  // Config and plugin discovery resolve from the same trusted environment the plugin
  // runs in, never from this process's ambient env.
  const archonHome = getArchonHome(context.trustedEnv);
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
  const { readConfig } = context.dependencies;
  const config = forgePluginConfigSchema.parse(
    readConfig
      ? await readConfig()
      : await readForgeConfig(options.configPath ?? getArchonConfigPath(archonHome))
  );
  return { archonHome, op, supplied, config };
}

/**
 * Host introspection reads the same trusted discovery metadata as dispatch;
 * it is not a plugin operation and never resolves a credential.
 */
async function answerMetadata(
  { archonHome, op, supplied, config }: ForgeInput,
  { operationId, trustedEnv, write }: ForgeCommandContext
): Promise<number> {
  const { host } = cliForgeMetadataRequestSchema.parse({ ...supplied, op, operationId });
  const discovery = await discoverPlugins({
    config,
    env: trustedEnv,
    pluginsDir: getPluginsPath(archonHome),
  });
  const plugin = discovery.byHost.get(host.toLowerCase());
  if (plugin) {
    await write({ operationId, ok: true, result: { op: 'metadata', value: plugin.metadata } });
    return 0;
  }
  const unavailable = discovery.unavailable.length > 0;
  await write({
    operationId,
    ok: false,
    error: {
      kind: unavailable ? 'process_failed' : 'no_plugin_for_host',
      message: unavailable
        ? discovery.unavailable.map(error => error.message).join('; ')
        : `no forge plugin claims ${host}`,
    },
  });
  return 1;
}

async function dispatchRequest(
  { archonHome, op, supplied, config }: ForgeInput,
  context: ForgeCommandContext
): Promise<ForgeDispatchResult> {
  const { attempt, operationId } = context;
  attempt.request = forgeRequestSchema.parse({ ...supplied, operationId, op });
  attempt.dispatched = true;
  const result = await (context.dependencies.dispatch ?? dispatchForge)(attempt.request, {
    config,
    env: context.trustedEnv,
    // The trusted directory `archon plugin add` writes; repo env cannot move it.
    pluginsDir: getPluginsPath(archonHome),
    // Repo scope may supply the credential named by trusted user config. It
    // cannot replace executable discovery or the plugin's runtime identity.
    credentialEnv: context.env,
  });
  attempt.credentialSource = result.credentialSource;
  return result;
}

/** Returns the exit code when the run audit could not be persisted. */
async function auditOperation(
  audit: ForgeOperationAudit,
  response: CliForgeResponse,
  context: ForgeCommandContext
): Promise<number | undefined> {
  const runId = context.env.WORKFLOW_ID;
  if (!runId) return undefined;
  try {
    await (context.dependencies.audit ?? persistAudit)(audit, runId);
    return undefined;
  } catch {
    // Retain the actual operation outcome on stdout. Audit failure is a
    // separate failure and never rewrites an observed result as a refusal.
    await writeResponse(response, context);
    process.stderr.write(
      `Forge operation ${context.operationId} completed but its run audit could not be persisted.\n`
    );
    return 2;
  }
}

/**
 * Once dispatch has begun, this process can no longer claim the request was
 * refused: a mutation may already have reached the forge.
 */
function failureResponse(
  error: unknown,
  { operationId, attempt: { request, dispatched } }: ForgeCommandContext
): CliForgeResponse {
  return {
    operationId,
    ok: false,
    error: {
      kind: dispatched ? 'process_failed' : 'invalid_request',
      message: failureMessage(error, dispatched),
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

function failureMessage(error: unknown, dispatched: boolean): string {
  if (dispatched) return 'Forge dispatch failed; reconcile the operation before retrying it';
  return error instanceof SyntaxError
    ? 'Invalid JSON input or configuration'
    : 'Invalid forge request or configuration; see archon forge --help';
}

function writeResponse(
  response: CliForgeResponse,
  { write, attempt: { credentialSource } }: ForgeCommandContext
): Promise<void> {
  return write({ ...response, ...(credentialSource ? { credentialSource } : {}) });
}
