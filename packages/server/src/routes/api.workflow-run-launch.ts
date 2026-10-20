import { unlink } from 'fs/promises';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AttachedFile, Conversation, HandleMessageContext, RunActor } from '@archon/core';
import { generateTitleForUser, resolveTitleRequest } from '@archon/core';
import { parseWorkflowRunConfig } from '@archon/core/config';
import * as messageDb from '@archon/core/db/messages';
import { getArchonWorkspacesPath } from '@archon/paths';
import { isValidWorkflowName } from '@archon/workflows/command-validation';
import { TIER_NAMES, isTierName } from '@archon/workflows/model-validation';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { WebAdapter } from '../adapters/web';
import { type OrchestratorDispatch, persistUploadedFiles } from './api-message-dispatch';
import { authorizeDispatchConversation } from './api-request-auth';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { dispatchResponseSchema } from './schemas/conversation.schemas';

// Body validation is handled manually below (multipart vs JSON
// branching), mirroring sendMessageRoute. The OpenAPI spec describes the
// shapes via the description; declaring `request.body` would force JSON
// validation to run on multipart payloads and reject them.
const runWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/{name}/run',
  tags: ['Workflows'],
  summary: 'Run a workflow via the orchestrator (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ conversationId, message, inputs?, config?, tiers?, aliases? }` or ' +
    '`multipart/form-data` with `conversationId`, `message`, optional `inputs` and `config` fields ' +
    'holding their objects JSON-encoded, optional `tiers` and `aliases` JSON object fields, ' +
    'and optional file attachments (max 5 files, ' +
    "10 MB each). `inputs` supplies values for the workflow's declared `inputs:` " +
    '(#2554); it is validated against the declaration before any worktree, clone, or AI ' +
    'cost, so a missing required input or an undeclared key is refused up front. `config` ' +
    'supplies a sparse runtime layer; `tiers` and `aliases` rebind named model presets above it. ' +
    'Caller-supplied filesystem config paths are rejected. JSON requests may supply ' +
    '`adopt_run_id` or `supersedes_run_id`, but not both. If dispatch would continue an ' +
    'existing run, either declaration is refused before continuation or its fresh fallback. ' +
    'The refusal names the existing run: resume it with `/workflow resume <id>`, abandon it ' +
    'with `/workflow abandon <id>` before retrying, or use a conversation with no open run. ' +
    'An accepted fresh supersede records `adopted_from_run_id` and ' +
    '`metadata.continuation.mode: "supersede"` on the new run.',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

/**
 * Validate a run request's declared-inputs map (#2554): a flat object whose every
 * value is a string, which is exactly the shape `readSubrunMetadata` will accept back
 * off the run row. Refuse anything else here rather than let it be persisted into a
 * shape the engine silently reads as absent.
 *
 * An empty object resolves to `undefined` so a caller sending `{}` is treated as
 * having supplied nothing, taking every declared default.
 */
function parseRunInputsField(
  raw: unknown
): { ok: true; inputs?: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'inputs must be an object mapping input names to strings' };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  const badKey = entries.find(([, value]) => typeof value !== 'string')?.[0];
  if (badKey !== undefined) {
    return { ok: false, error: `inputs value for '${badKey}' must be a string` };
  }
  return {
    ok: true,
    inputs: entries.length > 0 ? (raw as Record<string, string>) : undefined,
  };
}

function parseRunModelOverridesFields(
  rawTiers: unknown,
  rawAliases: unknown
): { ok: true; overrides?: RunModelOverrides } | { ok: false; error: string } {
  const parseMap = (
    raw: unknown,
    label: 'tiers' | 'aliases'
  ): { ok: true; value?: Record<string, string> } | { ok: false; error: string } => {
    if (raw === undefined || raw === null) return { ok: true };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${label} must be an object mapping names to model specs` };
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    for (const [name, spec] of entries) {
      if (typeof spec !== 'string' || spec.trim().length === 0) {
        return { ok: false, error: `${label} value for '${name}' must be a non-empty string` };
      }
      if (label === 'tiers' && !isTierName(name)) {
        return {
          ok: false,
          error: `Invalid tier '${name}'. Supported tiers: ${TIER_NAMES.join(', ')}`,
        };
      }
      if (label === 'aliases' && !name.startsWith('@')) {
        return { ok: false, error: `Alias '${name}' must start with '@'` };
      }
    }
    return {
      ok: true,
      value: entries.length > 0 ? (raw as Record<string, string>) : undefined,
    };
  };

  const tiers = parseMap(rawTiers, 'tiers');
  if (!tiers.ok) return tiers;
  const aliases = parseMap(rawAliases, 'aliases');
  if (!aliases.ok) return aliases;
  if (!tiers.value && !aliases.value) return { ok: true };
  return {
    ok: true,
    overrides: {
      ...(tiers.value ? { tiers: tiers.value } : {}),
      ...(aliases.value ? { aliases: aliases.value } : {}),
    } as RunModelOverrides,
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

type FormValue = string | File | (string | File)[];

/** A launch request whose body passed validation; nothing is authorized or written yet. */
interface RunLaunchRequest {
  conversationId: string;
  message: string;
  workflowInputs?: Record<string, string>;
  workflowModelOverrides?: RunModelOverrides;
  workflowRunConfig?: WorkflowRunConfigInput;
  // Between-run continuation (#2747): run-id only — no name-based newest-wins.
  adoptRunId?: string;
  supersedesRunId?: string;
  fileEntries: File[];
}

type RunLaunchOptions = Omit<RunLaunchRequest, 'conversationId' | 'message' | 'fileEntries'>;

const CONFIG_PATH_REFUSAL = 'configPath is not supported; send validated config content';

function parseInlineRunConfig(raw: unknown): Parsed<WorkflowRunConfigInput | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  try {
    return { ok: true, value: parseWorkflowRunConfig(raw, { kind: 'http', label: 'inline' }) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Decode a multipart field that carries an object JSON-encoded, since a form field can only be
 * a string. A malformed field is refused rather than ignored — silently dropping it would start
 * the run without the values the caller thought it sent.
 */
function decodeFormJsonField(
  raw: FormValue | undefined,
  error: string,
  logEvent: string,
  logContext: Record<string, string>
): Parsed<unknown> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (parseErr: unknown) {
    getLog().warn({ err: parseErr, ...logContext }, logEvent);
    return { ok: false, error };
  }
}

function parseMultipartRunOptions(
  body: Record<string, FormValue>,
  workflowName: string
): Parsed<RunLaunchOptions> {
  // Declared inputs (#2554).
  const decodedInputs = decodeFormJsonField(
    body.inputs,
    'inputs must be a JSON-encoded object of string values',
    'run_workflow.inputs_parse_failed',
    { workflowName }
  );
  if (!decodedInputs.ok) return decodedInputs;
  const inputs = parseRunInputsField(decodedInputs.value);
  if (!inputs.ok) return inputs;

  const decodeModelMap = (label: 'tiers' | 'aliases'): Parsed<unknown> =>
    decodeFormJsonField(
      body[label],
      `${label} must be a JSON-encoded object`,
      'run_workflow.model_overrides_parse_failed',
      { workflowName, field: label }
    );
  const tiers = decodeModelMap('tiers');
  if (!tiers.ok) return tiers;
  const aliases = decodeModelMap('aliases');
  if (!aliases.ok) return aliases;
  const overrides = parseRunModelOverridesFields(tiers.value, aliases.value);
  if (!overrides.ok) return overrides;

  const decodedConfig = decodeFormJsonField(
    body.config,
    'config must be a JSON-encoded object',
    'run_workflow.config_parse_failed',
    { workflowName }
  );
  if (!decodedConfig.ok) return decodedConfig;
  const runConfig = parseInlineRunConfig(decodedConfig.value);
  if (!runConfig.ok) return runConfig;

  return {
    ok: true,
    value: {
      workflowInputs: inputs.inputs,
      workflowModelOverrides: overrides.overrides,
      workflowRunConfig: runConfig.value,
    },
  };
}

async function parseMultipartRunRequest(
  c: Context,
  workflowName: string
): Promise<Parsed<RunLaunchRequest>> {
  let body: Record<string, FormValue>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (parseErr: unknown) {
    getLog().warn({ err: parseErr }, 'run_workflow.multipart_parse_failed');
    return { ok: false, error: 'Invalid multipart form data' };
  }

  const { message, conversationId } = body;
  if (typeof message !== 'string' || !message) {
    return { ok: false, error: 'message must be a non-empty string' };
  }
  if (typeof conversationId !== 'string' || !conversationId || !/^[\w-]+$/.test(conversationId)) {
    return { ok: false, error: 'conversationId must be a non-empty alphanumeric string' };
  }
  if (body.configPath !== undefined) return { ok: false, error: CONFIG_PATH_REFUSAL };

  const options = parseMultipartRunOptions(body, workflowName);
  if (!options.ok) return options;
  const files = Array.isArray(body.files) ? body.files : [body.files];
  return {
    ok: true,
    value: {
      conversationId,
      message,
      ...options.value,
      fileEntries: files.filter((e): e is File => e instanceof File),
    },
  };
}

function parseRunIdField(raw: unknown, field: string): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !raw) {
    return { ok: false, error: `${field} must be a non-empty run id` };
  }
  return { ok: true, value: raw };
}

function parseContinuationFields(body: {
  adopt_run_id?: unknown;
  supersedes_run_id?: unknown;
}): Parsed<Pick<RunLaunchRequest, 'adoptRunId' | 'supersedesRunId'>> {
  const adopt = parseRunIdField(body.adopt_run_id, 'adopt_run_id');
  if (!adopt.ok) return adopt;
  const supersede = parseRunIdField(body.supersedes_run_id, 'supersedes_run_id');
  if (!supersede.ok) return supersede;
  if (adopt.value && supersede.value) {
    return { ok: false, error: 'adopt_run_id and supersedes_run_id are mutually exclusive' };
  }
  return { ok: true, value: { adoptRunId: adopt.value, supersedesRunId: supersede.value } };
}

async function parseJsonRunRequest(c: Context): Promise<Parsed<RunLaunchRequest>> {
  let body: {
    conversationId?: unknown;
    message?: unknown;
    inputs?: unknown;
    tiers?: unknown;
    aliases?: unknown;
    config?: unknown;
    configPath?: unknown;
    adopt_run_id?: unknown;
    supersedes_run_id?: unknown;
  };
  try {
    body = await c.req.json();
  } catch (parseErr: unknown) {
    getLog().warn({ err: parseErr }, 'run_workflow.json_parse_failed');
    return { ok: false, error: 'Invalid JSON in request body' };
  }

  const { conversationId, message } = body;
  if (typeof conversationId !== 'string' || !conversationId) {
    return { ok: false, error: 'conversationId must be a non-empty string' };
  }
  if (typeof message !== 'string' || !message) {
    return { ok: false, error: 'message must be a non-empty string' };
  }
  if (body.configPath !== undefined) return { ok: false, error: CONFIG_PATH_REFUSAL };

  const inputs = parseRunInputsField(body.inputs);
  if (!inputs.ok) return inputs;
  const continuation = parseContinuationFields(body);
  if (!continuation.ok) return continuation;
  const overrides = parseRunModelOverridesFields(body.tiers, body.aliases);
  if (!overrides.ok) return overrides;
  const runConfig = parseInlineRunConfig(body.config);
  if (!runConfig.ok) return runConfig;

  return {
    ok: true,
    value: {
      conversationId,
      message,
      workflowInputs: inputs.inputs,
      workflowModelOverrides: overrides.overrides,
      workflowRunConfig: runConfig.value,
      ...continuation.value,
      fileEntries: [],
    },
  };
}

/** An authorized launch with its attachments on disk. */
interface RunLaunch {
  workflowName: string;
  request: RunLaunchRequest;
  actor: RunActor;
  savedFiles: AttachedFile[];
}

function actorUserId(actor: RunActor): string | undefined {
  return actor.kind === 'user' ? actor.userId : undefined;
}

async function persistLaunchFiles(
  request: RunLaunchRequest,
  workflowName: string
): ReturnType<typeof persistUploadedFiles> {
  const { conversationId, fileEntries } = request;
  if (fileEntries.length === 0) return { ok: true, savedFiles: [] };
  const result = await persistUploadedFiles(conversationId, fileEntries);
  if (result.ok) {
    getLog().info(
      { conversationId, fileCount: result.savedFiles.length, workflowName },
      'run_workflow.files_uploaded'
    );
  }
  return result;
}

async function removeLaunchFiles(launch: RunLaunch): Promise<void> {
  const { conversationId } = launch.request;
  for (const file of launch.savedFiles) {
    await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, filePath: file.path, conversationId }, 'upload.rollback_failed');
      }
    });
  }
}

/**
 * Persist the user message and register its DB ID (same as the message endpoint). File
 * metadata (name/mime/size — no path, since the on-disk file is ephemeral) goes into message
 * metadata when present. Returns false, with the uploads removed, when the message cannot be
 * saved.
 */
async function recordLaunchMessage(
  conv: Conversation,
  launch: RunLaunch,
  webAdapter: WebAdapter
): Promise<boolean> {
  const { workflowName, request, savedFiles } = launch;
  const userId = actorUserId(launch.actor);
  const meta =
    savedFiles.length > 0
      ? { files: savedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size })) }
      : undefined;
  try {
    await messageDb.addMessage(conv.id, 'user', request.message, meta, userId);
  } catch (e: unknown) {
    getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
    await removeLaunchFiles(launch);
    return false;
  }
  webAdapter.setConversationDbId(request.conversationId, conv.id);
  if (!conv.title) {
    // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
    // assistant default (#1855). Both calls never throw.
    void resolveTitleRequest(conv.ai_assistant_type, userId).then(titleRequest =>
      generateTitleForUser(
        conv.id,
        request.message,
        titleRequest,
        getArchonWorkspacesPath(),
        userId,
        workflowName
      )
    );
  }
  return true;
}

/**
 * The message and every run option ride typed fields, never a chat command string: tokenizing
 * the message would rewrite it and let a word in it set `--force` (#4159), and encoding inputs
 * would invent a chat grammar (#2554/#2555).
 */
function launchContext(launch: RunLaunch): Omit<HandleMessageContext, 'isolationHints'> {
  const { request, savedFiles } = launch;
  const { workflowInputs, workflowModelOverrides, workflowRunConfig } = request;
  return {
    actor: launch.actor,
    workflowName: launch.workflowName,
    ...(savedFiles.length > 0 ? { attachedFiles: savedFiles } : {}),
    ...(workflowInputs ? { workflowInputs } : {}),
    ...(workflowModelOverrides ? { workflowModelOverrides } : {}),
    ...(workflowRunConfig ? { workflowRunConfig } : {}),
    ...(request.adoptRunId ? { workflowAdoptRunId: request.adoptRunId } : {}),
    ...(request.supersedesRunId ? { workflowSupersedesRunId: request.supersedesRunId } : {}),
  };
}

interface RunLaunchDeps {
  webAdapter: WebAdapter;
  dispatchToOrchestrator: OrchestratorDispatch;
}

async function launchWorkflowRun(
  c: Context,
  workflowName: string,
  request: RunLaunchRequest,
  { webAdapter, dispatchToOrchestrator }: RunLaunchDeps
): Promise<Response> {
  // The conversation id arrives in the body, so attachments are written only
  // once it is known that the caller may reach this conversation.
  const access = await authorizeDispatchConversation(c, request.conversationId);
  if ('error' in access) return access.error;

  const uploaded = await persistLaunchFiles(request, workflowName);
  if (!uploaded.ok) return apiError(c, uploaded.status, uploaded.error);
  const launch: RunLaunch = {
    workflowName,
    request,
    actor: access.actor,
    savedFiles: uploaded.savedFiles,
  };

  try {
    if (access.conversation) {
      const recorded = await recordLaunchMessage(access.conversation, launch, webAdapter);
      if (!recorded) return apiError(c, 500, 'Failed to save workflow request to history');
    }
    const result = await dispatchToOrchestrator(
      request.conversationId,
      request.message,
      launchContext(launch),
      launch.savedFiles.length > 0 ? launch.savedFiles : undefined
    );
    return c.json(result);
  } catch (error) {
    getLog().error({ err: error }, 'run_workflow_failed');
    return apiError(c, 500, 'Failed to run workflow');
  }
}

export function registerWorkflowRunLaunchRoute(app: OpenAPIHono, deps: RunLaunchDeps): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // POST /api/workflows/:name/run - Run a workflow via the orchestrator
  //
  // Accepts either:
  //   - application/json: { conversationId, message, inputs?, tiers?, aliases? }
  //   - multipart/form-data: those maps JSON-encoded + files[] (≤5, ≤10MB each)
  //
  // Multipart matches /api/conversations/:id/message so the console's draft
  // run input can attach screenshots / stack traces / paste-blobs the same
  // way a freeform chat message can.
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!isValidWorkflowName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }
    const parsed = (c.req.header('content-type') ?? '').includes('multipart/form-data')
      ? await parseMultipartRunRequest(c, workflowName)
      : await parseJsonRunRequest(c);
    if (!parsed.ok) return apiError(c, 400, parsed.error);
    return launchWorkflowRun(c, workflowName, parsed.value, deps);
  });
}
