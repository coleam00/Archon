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
  type CliForgeResponse,
} from '@archon/forge';
import { z } from '@hono/zod-openapi';
import { writeJsonLine } from '../utils/stdout';
import type { RunMergeFacts, recordRunMerge } from './forge-merge-record';

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
      const failures = await recordRunFacts(runId, input, result, context);
      if (failures.length > 0) {
        // Retain the actual operation outcome on stdout. A failure to record it is a
        // separate failure and never rewrites an observed result as a refusal.
        await writeResponse(response, context);
        for (const failure of failures) process.stderr.write(`${failure}\n`);
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

/**
 * What a run-owned operation leaves on the run: its audit, and for an applied `pr.merge`
 * on a run with an item, the merge and landing branch on that item. Returns one stderr
 * line per record that could not be written; none of them throws, because the operation
 * has already reached the forge.
 */
async function recordRunFacts(
  runId: string,
  input: ForgeInput,
  { response, audit }: ForgeDispatchResult,
  context: ForgeCommandContext
): Promise<string[]> {
  const failures: string[] = [];
  const persist = async (operationAudit: ForgeOperationAudit): Promise<void> => {
    try {
      await (context.dependencies.audit ?? persistAudit)(operationAudit, runId);
    } catch {
      failures.push(
        `Forge operation ${operationAudit.operationId} completed but its run audit could not be persisted.`
      );
    }
  };
  await persist(audit);
  if (!response.ok || response.result.op !== 'pr.merge') return failures;
  const merged = response.result.value;
  // The merge result carries no merge time, so one `pr.view` reads it from the forge. The
  // read is audited on the run like any run forge read, after the item record has closed
  // its database connection, since `persistAudit` opens and closes its own.
  let viewAudit: ForgeOperationAudit | undefined;
  const readFacts = async (): Promise<RunMergeFacts> => {
    const view = await (context.dependencies.dispatch ?? dispatchForge)(
      {
        operationId: randomUUID(),
        op: 'pr.view',
        selector: { kind: 'number', ref: merged.target },
      },
      { ...trustedDiscovery(input, context), credentialEnv: context.env }
    );
    viewAudit = view.audit;
    if (!view.response.ok) throw new Error(`pr.view failed: ${view.response.error.message}`);
    const read = view.response.result.op === 'pr.view' ? view.response.result.value : null;
    if (read?.pr.state !== 'merged')
      throw new Error('pr.view does not read the pull request as merged');
    const at = read.timestamps?.merged_at;
    if (!at) throw new Error('the forge plugin reports no merge time in pr.view');
    return { change: merged.pr.url, commit: merged.landed.commit, at, branch: merged.pr.base };
  };
  try {
    const record =
      context.dependencies.recordMerge ?? (await import('./forge-merge-record')).recordRunMerge;
    await record(runId, readFacts, context.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push(
      `Forge operation ${context.operationId} merged ${merged.pr.url} but the item record could not be written: ${reason}`
    );
  }
  if (viewAudit) await persist(viewAudit);
  return failures;
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
