import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getArchonConfigPath, getArchonHome } from '@archon/paths/archon-paths';
import { getPluginsPath } from '@archon/paths';
import { discoverPlugins, type PluginDiscovery, type SourcePlugin } from '@archon/forge/discovery';
import { readForgeConfig, sourceForgePlugins } from '@archon/forge/host-plugins';
import { checkForgeAccess, dispatchForge, type ForgeOperationAudit } from '@archon/forge/dispatch';
import { type ForgePluginConfig, forgePluginConfigSchema } from '@archon/forge/plugin-config';
import {
  forgeRequestSchema,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
  type ForgeRequest,
} from '@archon/forge/operations';
import {
  cliForgeCheckRequestSchema,
  cliForgeMetadataRequestSchema,
  cliForgeResponseSchema,
  type CliForgeItemRecord,
  type CliForgeResponse,
} from '@archon/forge';
import { z } from '@hono/zod-openapi';
import { writeJsonLine } from '../utils/stdout';
import type { recordRunMerge } from './forge-merge-record';

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
  sourcePlugins?: readonly SourcePlugin[];
  audit?: typeof persistAudit;
  recordMerge?: typeof recordRunMerge;
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
    if (input.op === 'check') return await answerCheck(input, context);
    const result = await dispatchRequest(input, context);
    response = result.response;
    const runId = env.WORKFLOW_ID;
    if (runId) {
      const recorded = await recordRunFacts(runId, result, context);
      if (recorded.itemRecord && response.ok)
        response = { ...response, itemRecord: recorded.itemRecord };
      for (const line of recorded.stderr) process.stderr.write(`${line}\n`);
      if (recorded.failed) {
        // Retain the actual operation outcome on stdout. A failure to record it is a
        // separate failure and never rewrites an observed result as a refusal.
        await writeResponse(response, context);
        return 2;
      }
    }
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
 * Where metadata, check, dispatch and `validate workflows` all find plugins, so a
 * preflight never answers for a different plugin than the one dispatch runs.
 */
function discoveryOptions(
  archonHome: string,
  config: ForgePluginConfig,
  trustedEnv: NodeJS.ProcessEnv,
  sourcePlugins: readonly SourcePlugin[] = sourceForgePlugins()
): {
  config: ForgePluginConfig;
  env: NodeJS.ProcessEnv;
  pluginsDir: string;
  sourcePlugins: readonly SourcePlugin[];
} {
  return {
    config,
    env: trustedEnv,
    // The trusted directory `archon plugin add` writes; repo env cannot move it.
    pluginsDir: getPluginsPath(archonHome),
    sourcePlugins,
  };
}

function trustedDiscovery(
  { archonHome, config }: ForgeInput,
  { trustedEnv, dependencies }: ForgeCommandContext
): ReturnType<typeof discoveryOptions> {
  return discoveryOptions(archonHome, config, trustedEnv, dependencies.sourcePlugins);
}

/** The forge plugins this install loads, discovered as every `archon forge` command does. */
export async function discoverInstalledForgePlugins(
  trustedEnv: NodeJS.ProcessEnv
): Promise<PluginDiscovery> {
  const archonHome = getArchonHome(trustedEnv);
  const config = forgePluginConfigSchema.parse(
    await readForgeConfig(getArchonConfigPath(archonHome))
  );
  return discoverPlugins(discoveryOptions(archonHome, config, trustedEnv));
}

/**
 * Host introspection reads the same trusted discovery metadata as dispatch;
 * it is not a plugin operation and never resolves a credential.
 */
async function answerMetadata(input: ForgeInput, context: ForgeCommandContext): Promise<number> {
  const { op, supplied } = input;
  const { operationId, write } = context;
  const { host } = cliForgeMetadataRequestSchema.parse({ ...supplied, op, operationId });
  const discovery = await discoverPlugins(trustedDiscovery(input, context));
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

/**
 * A preflight for a workflow about to spend: the plugin, its capabilities and the
 * credential source, read the way dispatch reads them, and for a remote or repository
 * whose plugin advertises `pr.view` one read with that credential. The read is not audited: a check runs before the run it
 * guards exists.
 */
async function answerCheck(input: ForgeInput, context: ForgeCommandContext): Promise<number> {
  const { op, supplied } = input;
  const { operationId, env, write } = context;
  const request = cliForgeCheckRequestSchema.parse({ ...supplied, op, operationId });
  const check = await checkForgeAccess(request, {
    ...trustedDiscovery(input, context),
    credentialEnv: env,
  });
  if (!check.ok) {
    const { error, unsupported, remedy } = check;
    await write({
      operationId,
      ok: false,
      error,
      ...(unsupported ? { unsupported } : {}),
      ...(remedy ? { remedy } : {}),
    });
    return 1;
  }
  const { host, plugin, credentialSource } = check;
  await write({
    operationId,
    ok: true,
    result: {
      op: 'check',
      value: {
        host,
        plugin,
        operations: request.operations,
        ...(credentialSource ? { credentialSource } : {}),
      },
    },
  });
  return 0;
}

async function dispatchRequest(
  input: ForgeInput,
  context: ForgeCommandContext
): Promise<ForgeDispatchResult> {
  const { op, supplied } = input;
  const { attempt, operationId } = context;
  attempt.request = forgeRequestSchema.parse({ ...supplied, operationId, op });
  attempt.dispatched = true;
  const result = await (context.dependencies.dispatch ?? dispatchForge)(attempt.request, {
    ...trustedDiscovery(input, context),
    // Repo scope may supply the credential named by trusted user config. It
    // cannot replace executable discovery or the plugin's runtime identity.
    credentialEnv: context.env,
  });
  attempt.credentialSource = result.credentialSource;
  return result;
}

/** What a run-owned operation left on the run, and what the caller is told about it. */
interface RunRecord {
  /** One line per record that could not be written, or that the result could not supply. */
  stderr: string[];
  /** A record could not be written: the command exits 2. */
  failed: boolean;
  itemRecord?: CliForgeItemRecord;
}

/**
 * What a run-owned operation leaves on the run: its audit, and for an applied `pr.merge`
 * on a run with an item, the merge and landing branch on that item, from the merge result.
 * Nothing here throws, because the operation has already reached the forge.
 */
async function recordRunFacts(
  runId: string,
  { response, audit }: ForgeDispatchResult,
  context: ForgeCommandContext
): Promise<RunRecord> {
  const record: RunRecord = { stderr: [], failed: false };
  try {
    await (context.dependencies.audit ?? persistAudit)(audit, runId);
  } catch {
    record.failed = true;
    record.stderr.push(
      `Forge operation ${context.operationId} completed but its run audit could not be persisted.`
    );
  }
  if (!response.ok || response.result.op !== 'pr.merge') return record;
  const merged = response.result.value;
  try {
    const recordMerge =
      context.dependencies.recordMerge ?? (await import('./forge-merge-record')).recordRunMerge;
    const outcome = await recordMerge(
      runId,
      {
        change: merged.pr.url,
        commit: merged.landed.commit,
        at: merged.merged_at,
        branch: merged.pr.base,
      },
      context.env
    );
    if (outcome === 'recorded') record.itemRecord = { recorded: true };
    if (outcome === 'no_merge_time') {
      // The merge happened, so this is no failure: the caller is told, and the exit stays 0.
      record.itemRecord = { recorded: false, reason: 'no_merge_time' };
      record.stderr.push(
        `Forge operation ${context.operationId} merged ${merged.pr.url}, but the forge plugin reported no merge time, so the merge and its landing branch were not recorded on the run's item. Update the forge plugin with \`archon plugin update\`.`
      );
    }
  } catch (error) {
    record.failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    record.stderr.push(
      `Forge operation ${context.operationId} merged ${merged.pr.url} but the item record could not be written: ${reason}`
    );
  }
  return record;
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
  if (error instanceof SyntaxError) return 'Invalid JSON input or configuration';
  const fields = error instanceof z.ZodError ? `: ${invalidFields(error)}` : '';
  return `Invalid forge request or configuration${fields}; see archon forge --help`;
}

/** How many refused fields a message names before it only counts the rest. */
const NAMED_FIELDS = 6;

/**
 * Names each refused field and what the schema expected there, so the caller can correct
 * the request. Schema messages describe the expected type, never the supplied value.
 */
function invalidFields(error: z.ZodError): string {
  const issues = refusedIssues(error.issues);
  const named = issues
    .slice(0, NAMED_FIELDS)
    .map(issue => `${issue.path.join('.') || '(request)'}: ${issue.message}`);
  const rest = issues.length - named.length;
  return [...named, ...(rest > 0 ? [`and ${rest} more`] : [])].join('; ');
}

/** A request no alternative admits is named by the alternative it came closest to. */
function refusedIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap(issue => {
    if (issue.code !== 'invalid_union' || issue.errors.length === 0) return [issue];
    const closest = issue.errors.reduce((best, errors) =>
      errors.length < best.length ? errors : best
    );
    return refusedIssues(closest).map(nested => ({
      ...nested,
      path: [...issue.path, ...nested.path],
    }));
  });
}

function writeResponse(
  response: CliForgeResponse,
  { write, attempt: { credentialSource } }: ForgeCommandContext
): Promise<void> {
  return write({ ...response, ...(credentialSource ? { credentialSource } : {}) });
}
