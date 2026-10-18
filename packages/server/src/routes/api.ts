import {
  ActiveContainerEnvironmentsError,
  ActiveWorktreeEnvironmentsError,
  WorktreeRegistrationChangedError,
} from '@archon/core/db/codebase-delete-error';
import { WebPushDestination } from '../services/web-push';
import { PUSH_DESTINATION_STATES, type AttentionRouter } from '../services/attention-router';
import { deleteWebPushSubscription } from '@archon/core/db/web-push-subscriptions';
import {
  webPushSubscriptionSchema,
  webPushDeleteSchema,
  webPushKeySchema,
  webPushSuccessSchema,
  webPushPayloadSchema,
} from '@archon/core/schemas/web-push';
import { getAgentProvider } from '@archon/core/services/provider-admission';
import { detectProjectKind, ProjectKindDetectionError } from '@archon/core/services/project-kind';
import { missingProviderMessage } from '@archon/provider-contract';
import { RunActionForbiddenError } from '@archon/core/operations/run-authorization';
/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { providerRegistry } from '@archon/providers';

import { buildRunNodeStates, getTerminalRecord } from '@archon/workflows/terminal-record';
import { nodeCostScope } from '@archon/workflows/node-record-serialization';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { serializeWorkflowPreservingText, WorkflowReadBackError } from './workflow-yaml';
import { rm, readFile, writeFile, unlink, mkdir, readdir, realpath, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { normalize, join, basename, dirname, resolve } from 'path';
import type { Context } from 'hono';
import type {
  ConversationLockManager,
  AttachedFile,
  HandleMessageContext,
  GlobalConfig,
  TiersPatch,
  SchemaVersionInfo,
} from '@archon/core';
import {
  getDatabaseType,
  getSchemaVersion,
  loadConfig,
  loadRepoConfig,
  toSafeConfig,
  updateGlobalConfig,
  cloneRepository,
  type CloneOptions,
  inspectProjectBaseBranch,
  ProjectRegistrationError,
  registerRepository,
  registerFolder,
  generateTitleForUser,
  resolveTitleRequest,
} from '@archon/core';
import type { AliasesPatch } from '@archon/core';
import { InvalidConfigError, parseWorkflowRunConfig } from '@archon/core/config';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import {
  ConfiguredBaseBranchNotFoundError,
  isWorktreeRegistered,
  removeWorktree,
  toRepoPath,
  toWorktreePath,
} from '@archon/git';
import {
  canonicalizeProjectPath,
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getBundledWorkflowsPath,
  getArchonWorkspacesPath,
  getHomeCommandsPath,
  getHomeWorkflowsPath,
  getRunArtifactsDirForRoot,
  isRunArtifactsEngineEntry,
  resolveRunStorageRoot,
  isInsideArchonHome,
  isInsideArchonWorkspaces,
  isPathInside,
  getArchonHome,
  isDocker,
  isWSL,
  getWSLDistroName,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import {
  discoverWorkflowsWithConfig,
  isValidWorkflowFolderSegment,
} from '@archon/workflows/workflow-discovery';
import { FIXTURES_DIR } from '@archon/workflows/fixture-layout';
import { parseWorkflow, parseYaml } from '@archon/workflows/loader';
import { resolveWorkflowName } from '@archon/workflows/router';
import { isValidCommandName, isValidWorkflowName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  continuablePause,
  isApprovalContext,
  isGateResolved,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { signalWorkflowWaitRequestSchema } from '@archon/core/schemas/workflow-run';
import { findCommandFiles } from '@archon/core/utils/commands';
import { resumeWorkflowRunFromServer } from '../services/workflow-resume-service';
import {
  apiError,
  getLog,
  getValidatedBody,
  getValidatedQuery,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  authorizeConversation,
  authorizeDispatchConversation,
  requireWebUser,
  resolveAuthContext,
  resolveRunActor,
} from './api-request-auth';
import { toApiCodebase, toApiDashboardWorkflowRun, toApiWorkflowRun } from './api-serializers';
import { createOrchestratorDispatch, persistUploadedFiles } from './api-message-dispatch';
import { toCleanEntry, validatePresetEntry } from './api-preset-entry';
import { registerAuthRoutes } from './api.auth';
import { registerProviderKeyRoutes } from './api.provider-keys';
import { registerConversationRoutes } from './api.conversations';
import { registerMessageRoutes } from './api.messages';
import { registerUserAiPrefsRoutes } from './api.user-ai-prefs';

interface RawWorkflowFile {
  absolutePath: string;
  filename: string;
  packaged: boolean;
  parsed: ReturnType<typeof parseWorkflow>;
  /** The file text as read. */
  content: string;
}

async function tryReadWorkflowAt(dir: string, name: string): Promise<RawWorkflowFile | null> {
  const acceptedNames = new Set(name.includes('/') ? [name, basename(name)] : [name]);
  for (const ext of ['yaml', 'yml']) {
    const filename = `${name}.${ext}`;
    const absolutePath = join(dir, filename);
    try {
      const content = await readFile(absolutePath, 'utf-8');
      const parsed = parseWorkflow(content, filename, providerRegistry);
      if (parsed.workflow !== null && !acceptedNames.has(parsed.workflow.name)) continue;
      return { absolutePath, filename, packaged: false, parsed, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

/**
 * The workflow as authored: the YAML mapping before the engine's normalizing
 * transform. The builder edits this shape, and the normalized `workflow` cannot
 * be sent back (validate rejects it), so GET returns both. Parsed with the same
 * parser the loader uses; undefined when the top level is not a mapping.
 */
function authoredForm(content: string): Record<string, unknown> | undefined {
  const raw = parseYaml(content);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

async function findPackagedWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let match: RawWorkflowFile | null = null;
  for (const pack of packs.sort((a, b) => a.localeCompare(b))) {
    if (pack === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(pack)) continue;
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    let workflowFolders: string[];
    try {
      workflowFolders = await readdir(packPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
      if (workflowFolder === FIXTURES_DIR) continue;
      if (!isValidWorkflowFolderSegment(workflowFolder)) continue;
      const workflowPath = join(packPath, workflowFolder);
      try {
        if (!(await stat(workflowPath)).isDirectory()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }

      let workflowEntries: string[];
      try {
        workflowEntries = await readdir(workflowPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const yamlFiles = workflowEntries
        .filter(entry => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort((a, b) => a.localeCompare(b));
      if (yamlFiles.length !== 1) continue;

      const yamlFilename = yamlFiles[0];
      const absolutePath = join(workflowPath, yamlFilename);
      let content: string;
      try {
        content = await readFile(absolutePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const parsed = parseWorkflow(content, yamlFilename, providerRegistry);
      const yamlStem = yamlFilename.replace(/\.ya?ml$/, '');
      const isMalformedTarget =
        parsed.workflow === null && (yamlStem === name || workflowFolder === name);
      if (parsed.workflow?.name !== name && !isMalformedTarget) continue;
      if (match !== null) {
        throw new Error(`Multiple packaged workflows declare the name '${name}'`);
      }
      match = {
        absolutePath,
        filename: `${pack}/${workflowFolder}/${yamlFilename}`,
        packaged: true,
        parsed,
        content,
      };
    }
  }
  return match;
}

async function findWorkflowAt(
  workflowsRoot: string,
  name: string
): Promise<RawWorkflowFile | null> {
  return (
    (await tryReadWorkflowAt(workflowsRoot, name)) ??
    (await findPackagedWorkflowAt(workflowsRoot, name))
  );
}

function isBundledWorkflowsRoot(workflowsRoot: string): boolean {
  return resolve(workflowsRoot) === resolve(getBundledWorkflowsPath());
}

function findBundledWorkflow(
  name: string
): { filename: string; parsed: ReturnType<typeof parseWorkflow>; content: string } | null {
  const direct = BUNDLED_WORKFLOWS[name];
  if (direct !== undefined) {
    const filename = `${name}.yaml`;
    const parsed = parseWorkflow(direct, filename, providerRegistry);
    if (parsed.error !== null || parsed.workflow?.name === name) {
      return { filename, parsed, content: direct };
    }
  }

  let match: {
    filename: string;
    parsed: ReturnType<typeof parseWorkflow>;
    content: string;
  } | null = null;
  for (const [filenameStem, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    if (filenameStem === name) continue;
    const filename = `${filenameStem}.yaml`;
    const parsed = parseWorkflow(content, filename, providerRegistry);
    if (parsed.workflow?.name !== name) continue;
    if (match !== null) throw new Error(`Multiple bundled workflows declare the name '${name}'`);
    match = { filename, parsed, content };
  }
  return match;
}
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import * as messageDb from '@archon/core/db/messages';
import {
  AbandonOwnerNotStoppedError,
  CancelRefusedError,
  describeAbandonOwner,
  describeReleasedWorktrees,
  AbandonRefusedError,
  assertAnswerAdmissible,
  assertAnswerable,
  assertResponseAccepted,
  attentionAnswerFor,
  assertLabelable,
  expectedGateForOccurrence,
  StaleGateAnswerError,
  type GateAnswerOrigin,
} from '@archon/core/operations/workflow-operations';
import {
  createSqlWorkflowOperations,
  createWorkflowHostStore,
} from '@archon/core/workflows/sql-host';
import {
  attentionQueueSource,
  resolveAttentionProject,
} from '@archon/core/operations/attention-queue';
import {
  attentionQueueItems,
  countAttentionQueue,
  parseAttentionQueueRequest,
  readAttentionQueueItem,
  selectAttentionQueue,
  type AttentionQueueScope,
} from '@archon/workflows/attention-queue';
import { isApiGateEnabled, isConversationOwnershipEnforced } from '../auth';
import { errorSchema } from './schemas/common.schemas';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import {
  workflowListResponseSchema,
  workflowLoadErrorSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  getWorkflowResponseSchema,
  saveWorkflowBodySchema,
  deleteWorkflowResponseSchema,
  commandListResponseSchema,
  workflowRunListResponseSchema,
  workflowRunDetailSchema,
  providerEventsQuerySchema,
  providerEventsResponseSchema,
  workflowRunByWorkerResponseSchema,
  cancelWorkflowRunResponseSchema,
  workflowRunActionResponseSchema,
  dashboardRunsResponseSchema,
  dashboardRunsQuerySchema,
  workflowRunsQuerySchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
  respondWorkflowRunBodySchema,
  answerWorkflowRunBodySchema,
  attentionQueueQuerySchema,
  attentionQueueCountsResponseSchema,
  attentionQueueItemResponseSchema,
  labelAttentionBodySchema,
  labelAttentionResponseSchema,
  resetWorkflowNodeSessionsParamsSchema,
  resetWorkflowNodeSessionsQuerySchema,
  resetWorkflowNodeSessionsResponseSchema,
  listArtifactsResponseSchema,
  workflowSourceSchema,
} from './schemas/workflow.schemas';
import { dispatchResponseSchema } from './schemas/conversation.schemas';
import {
  codebaseListResponseSchema,
  codebaseSchema,
  codebaseIdParamsSchema,
  addCodebaseBodySchema,
  renameCodebaseBodySchema,
  inspectBaseBranchBodySchema,
  inspectBaseBranchResponseSchema,
  deleteCodebaseResponseSchema,
  codebaseEnvVarsResponseSchema,
  setEnvVarBodySchema,
  codebaseEnvVarParamsSchema,
  envVarMutationResponseSchema,
} from './schemas/codebase.schemas';
import {
  updateAssistantConfigBodySchema,
  updateAssistantConfigResponseSchema,
  configResponseSchema,
  updateTiersBodySchema,
  updateAliasesBodySchema,
  codebaseEnvironmentsResponseSchema,
} from './schemas/config.schemas';
import { validateAliasName } from './alias-name';
import { TIER_NAMES, isTierName } from '@archon/workflows/model-validation';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import {
  providerListResponseSchema,
  piModelListResponseSchema,
  opencodeCredentialListResponseSchema,
} from './schemas/provider.schemas';
import { getProviderInfoList, isRegisteredProvider } from '@archon/providers';
import { introspectOpencodeCredentials } from '@archon/providers/community/opencode';
import { dagNodeSseEventSchema } from '../adapters/web/workflow-event.schemas';
import {
  runsNeedingAttentionResponseSchema,
  runAttentionSchema,
  RUN_ATTENTION_SCHEMA_NAME,
  workflowRunStatusSchema,
} from './schemas/workflow.schemas';

// Read app version: use build-time constant in binary, package.json in dev
let appVersion = 'unknown';
if (BUNDLED_IS_BINARY) {
  appVersion = BUNDLED_VERSION;
} else {
  try {
    const pkgContent = readFileSync(join(import.meta.dir, '../../../../package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version?: string };
    appVersion = pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug(
      { err, path: join(import.meta.dir, '../../../../package.json') },
      'api.version_read_failed'
    );
  }
}

type WorkflowSource = z.infer<typeof workflowSourceSchema>;

/**
 * Resolve the on-disk artifact directory for a run, for EVERY project kind
 * (#2200).
 *
 * Both artifact routes previously did `parseOwnerRepo(codebase.name)` alone,
 * which returns null for a folder project (display name, no slash) and for a
 * no-remote local repo (bare basename) — so artifact browsing was silently dead
 * for two of the three project kinds Archon can register.
 *
 * The shared root resolver owns trusted persisted-root precedence and
 * relocation fallback; this route only composes the artifact directory.
 */
function resolveRunArtifactDir(
  run: { output_root?: string | null },
  codebase: { kind?: string | null; name: string; default_cwd: string } | null,
  runId: string
): string | null {
  const root = resolveRunStorageRoot(run, codebase);
  return root ? getRunArtifactsDirForRoot(root, runId) : null;
}

// =========================================================================
// OpenAPI route configs (module-scope — pure config, no runtime dependencies)
// =========================================================================

/**
 * A paused-gate refusal. `childRunId` is present when the answer is "act on the child run
 * instead", so a client reads the run to act on instead of parsing it out of the message.
 */
const gateRefusalSchema = errorSchema
  .extend({ childRunId: z.string().optional() })
  .openapi('GateRefusal');
type GateRefusal = z.infer<typeof gateRefusalSchema>;

/** Helper to build the gate routes' 400 response entry for createRoute configs. */
function jsonGateRefusal(description: string): {
  content: { 'application/json': { schema: typeof gateRefusalSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: gateRefusalSchema } }, description };
}

const cwdQuerySchema = z.object({ cwd: z.string().optional() });
const workflowTargetQuerySchema = cwdQuerySchema.extend({
  source: z.enum(['project', 'global']).optional(),
});

const getWorkflowsRoute = createRoute({
  method: 'get',
  path: '/api/workflows',
  tags: ['Workflows'],
  summary: 'List available workflows',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const validateWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/validate',
  tags: ['Workflows'],
  summary: 'Validate a workflow definition without saving',
  request: {
    body: {
      content: { 'application/json': { schema: validateWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: validateWorkflowResponseSchema } },
      description: 'Validation result',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRoute = createRoute({
  method: 'get',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Fetch a single workflow definition',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Workflow definition',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const saveWorkflowRoute = createRoute({
  method: 'put',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Save (create or update) a workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
    body: { content: { 'application/json': { schema: saveWorkflowBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Saved workflow',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Delete a user-defined workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: workflowTargetQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteWorkflowResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getCommandsRoute = createRoute({
  method: 'get',
  path: '/api/commands',
  tags: ['Commands'],
  summary: 'List available command names for the workflow node palette',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: commandListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Codebase route configs
// =========================================================================

const listCodebasesRoute = createRoute({
  method: 'get',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'List registered codebases',
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getCodebaseRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Get a codebase by ID',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const inspectBaseBranchRoute = createRoute({
  method: 'post',
  path: '/api/codebases/base-branch',
  tags: ['Codebases'],
  summary: 'Inspect the remote default without registering a project',
  request: {
    body: {
      content: { 'application/json': { schema: inspectBaseBranchBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: inspectBaseBranchResponseSchema } },
      description: 'Base branch inspection',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const addCodebaseRoute = createRoute({
  method: 'post',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'Register a codebase (clone from URL or register local path)',
  request: {
    body: {
      content: { 'application/json': { schema: addCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase already existed',
    },
    201: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase created',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const renameCodebaseRoute = createRoute({
  method: 'patch',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Rename a codebase',
  description:
    'Changes the display name. Refused with 409 when another codebase already uses the name, ' +
    'or when the new name would move the project storage (worktrees, state, logs, artifacts).',
  request: {
    params: codebaseIdParamsSchema,
    body: {
      content: { 'application/json': { schema: renameCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Renamed codebase',
    },
    400: jsonError('Bad request'),
    404: jsonError('Codebase not found'),
    409: jsonError('Name already used, or the rename would move project storage'),
    500: jsonError('Server error'),
  },
});

const deleteCodebaseRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Delete a codebase and clean up associated resources',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteCodebaseResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    409: jsonError('Active container environments or newly registered worktrees require cleanup'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Codebase env var route configs
// =========================================================================

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'List env vars for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvVarsResponseSchema } },
      description: 'Env vars for codebase',
    },
    404: jsonError('Codebase not found'),
  },
});

const setEnvVarRoute = createRoute({
  method: 'put',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'Set (upsert) an env var for a codebase',
  request: {
    params: codebaseIdParamsSchema,
    body: { content: { 'application/json': { schema: setEnvVarBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var set',
    },
    404: jsonError('Codebase not found'),
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}/env/{key}',
  tags: ['Codebases'],
  summary: 'Delete an env var from a codebase',
  request: { params: codebaseEnvVarParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var deleted',
    },
    404: jsonError('Codebase not found'),
  },
});

// =========================================================================
// Workflow run route configs
// =========================================================================

// Body validation is handled manually in the handler (multipart vs JSON
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
    'Caller-supplied filesystem config paths are rejected.',
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

const listRunArtifactsRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/artifacts',
  tags: ['Workflows'],
  summary: "List a run's artifact files",
  description:
    "Walks the run's artifact directory and returns relative file paths with size + " +
    "mtime. Drives the console Artifacts tab. Leaves out only the engine's own " +
    '`.archon` child at the root, the same rule `archon workflow get` applies; a ' +
    "workflow's own dotfiles are listed. Resolves for every project kind — " +
    "`owner/repo`, `_local/<basename>`, and `_folder/<slug>` — preferring the run's " +
    'persisted `output_root` and re-deriving from the codebase when it is absent or ' +
    'no longer inside ARCHON_HOME. Returns `{ files: [] }` only when the location ' +
    'resolved and the run genuinely wrote nothing; returns 404 when the output ' +
    'location cannot be resolved at all.',
  request: {
    params: z.object({ runId: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: listArtifactsResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getRunsNeedingAttentionRoute = createRoute({
  method: 'get',
  path: '/api/runs/attention',
  tags: ['Workflows'],
  summary: 'List or count the attention queue',
  request: { query: attentionQueueQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.union([runsNeedingAttentionResponseSchema, attentionQueueCountsResponseSchema]),
        },
      },
      description: 'The items in scope, or their counts when countBy is given',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getRunAttentionItemRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/attention',
  tags: ['Workflows'],
  summary: 'Read the attention queue item a run stands for',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: attentionQueueItemResponseSchema } },
      description: 'The item, or null when the run needs no one now',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const labelRunAttentionRoute = createRoute({
  method: 'post',
  path: '/api/runs/{runId}/attention/labels',
  tags: ['Workflows'],
  summary: 'Set or remove labels on the attention wait a run is paused at',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: labelAttentionBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: labelAttentionResponseSchema } },
      description: 'Labeled',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The write names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

const getDashboardRunsRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/runs',
  tags: ['Workflows'],
  summary: 'List enriched workflow runs for the Command Center dashboard',
  request: { query: dashboardRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dashboardRunsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getWorkflowRunByWorkerRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/by-worker/{platformId}',
  tags: ['Workflows'],
  summary: 'Look up a workflow run by its worker conversation platform ID',
  request: { params: z.object({ platformId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunByWorkerResponseSchema } },
      description: 'Workflow run',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listWorkflowRunsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs',
  tags: ['Workflows'],
  summary: 'List workflow runs',
  request: { query: workflowRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const cancelWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/cancel',
  tags: ['Workflows'],
  summary: 'Cancel a workflow run',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: cancelWorkflowRunResponseSchema } },
      description: 'Cancelled',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError(
      'No live owner answered, or the owner could not be stopped; the run was not changed'
    ),
    500: jsonError('Server error'),
  },
});

const resumeWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/resume',
  tags: ['Workflows'],
  summary: 'Resume a failed workflow run (dispatches resume on the parent web conversation)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Resumed',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('Resource busy; the run keeps its state'),
    500: jsonError('Server error'),
  },
});

const signalWorkflowWaitRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/signal',
  tags: ['Workflows'],
  summary:
    'Signal an external event awaited by a paused workflow run; use occurrence for an exact match',
  request: {
    params: z.object({ runId: z.string() }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: signalWorkflowWaitRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Signal accepted; the scheduler will resume the workflow shortly',
    },
    400: jsonError('Run is not waiting on this event'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const abandonWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/abandon',
  tags: ['Workflows'],
  summary: 'Abandon a workflow run (mark as cancelled)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Abandoned',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('Abandonment or worktree release refused; inspect the reported reason'),
    500: jsonError('Server error'),
  },
});

const approveWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/approve',
  tags: ['Workflows'],
  summary: 'Approve a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: approveWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Approved',
    },
    400: jsonGateRefusal('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The answer names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

const rejectWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/reject',
  tags: ['Workflows'],
  summary: 'Reject a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: rejectWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Rejected',
    },
    400: jsonGateRefusal('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The answer names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

const respondWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/respond',
  tags: ['Workflows'],
  summary: "Resolve a paused workflow run with any of the gate's declared decisions",
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: respondWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Responded',
    },
    400: jsonGateRefusal('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The answer names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

const answerWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/answer',
  tags: ['Workflows'],
  summary: 'Answer a paused attention wait in its declared form',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: answerWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Answered',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    409: jsonError('The answer names an occurrence the run is no longer paused at'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRunRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Delete a workflow run and its events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    403: jsonError('Run action forbidden'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const resetWorkflowNodeSessionsRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}/node-sessions',
  tags: ['Workflows'],
  summary:
    'Reset persisted per-node provider sessions for a workflow. Optional scope and node filters narrow the deletion.',
  request: {
    params: resetWorkflowNodeSessionsParamsSchema,
    query: resetWorkflowNodeSessionsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: resetWorkflowNodeSessionsResponseSchema } },
      description: 'Sessions deleted (deleted count may be 0)',
    },
    400: jsonError('Bad request'),
    401: jsonError('Authentication required'),
    403: jsonError('All-scopes reset is unavailable while conversations are private'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
    503: jsonError('Identity backend unavailable'),
  },
});

const getWorkflowRunRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Get workflow run details with events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunDetailSchema } },
      description: 'Workflow run detail',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getProviderEventsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}/provider-events',
  tags: ['Workflows'],
  summary: "List a run's provider events",
  description:
    "Every event the run's providers streamed (text, thinking, tool calls with output, warnings, MCP status, compaction, subtasks, hooks, state), as the engine recorded them. Grouped by node; each node's in emission order. Rows written before the engine recorded envelopes come back translated, with a null attemptId.",
  request: { params: z.object({ runId: z.string() }), query: providerEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: providerEventsResponseSchema } },
      description: 'Provider events',
    },
    400: jsonError('Invalid cursor'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Config / health route configs
// =========================================================================

const getConfigRoute = createRoute({
  method: 'get',
  path: '/api/config',
  tags: ['System'],
  summary: 'Get read-only configuration (safe subset)',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: configResponseSchema,
        },
      },
      description: 'Configuration',
    },
    500: jsonError('Server error'),
  },
});

const patchAssistantConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/assistants',
  tags: ['System'],
  summary: 'Update assistant configuration',
  request: {
    body: {
      content: { 'application/json': { schema: updateAssistantConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateAssistantConfigResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchTiersConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/tiers',
  tags: ['System'],
  summary: 'Update model-tier presets (small/medium/large)',
  description:
    'Writes the `tiers:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-tier merge; a `null` tier value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateTiersBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body, or the resulting config is invalid'),
    500: jsonError('Server error'),
  },
});

const patchAliasesConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/aliases',
  tags: ['System'],
  summary: 'Update @custom model aliases',
  description:
    'Writes the `aliases:` config to ~/.archon/config.yaml. Ungated (works on solo ' +
    'installs). Per-alias merge; a `null` alias value unsets it.',
  request: {
    body: {
      content: { 'application/json': { schema: updateAliasesBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: configResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError(
      'Invalid alias name, unknown provider, invalid effort, or the resulting config is invalid'
    ),
    500: jsonError('Server error'),
  },
});

const getPiModelsRoute = createRoute({
  method: 'get',
  path: '/api/providers/pi/models',
  tags: ['System'],
  summary: "List Pi's model catalog (cost/reasoning metadata for the tier picker)",
  description:
    'Best-effort hint surface: returns `{ models: [] }` when the Pi catalog ' +
    'cannot be loaded, never an error — tier/alias saves must not depend on it.',
  responses: {
    200: {
      content: { 'application/json': { schema: piModelListResponseSchema } },
      description: 'Pi model catalog (metadata only)',
    },
  },
});

const getProvidersRoute = createRoute({
  method: 'get',
  path: '/api/providers',
  tags: ['System'],
  summary: 'List registered AI providers',
  responses: {
    200: {
      content: { 'application/json': { schema: providerListResponseSchema } },
      description: 'List of registered providers',
    },
  },
});

const getOpencodeCredentialsRoute = createRoute({
  method: 'get',
  path: '/api/providers/opencode/credentials',
  tags: ['System'],
  summary: "Introspect OpenCode's backend providers and auth state",
  description:
    "Proxies the embedded OpenCode server's provider introspection (catalog, " +
    'env var names, install-wide connected state). Heavyweight: starts the ' +
    'embedded server when not already running — call on demand from the ' +
    'settings card, never on passive page load (#1955).',
  responses: {
    200: {
      content: { 'application/json': { schema: opencodeCredentialListResponseSchema } },
      description: 'OpenCode backend providers (metadata only, no secrets)',
    },
    503: jsonError('Embedded OpenCode runtime unavailable'),
  },
});

const getCodebaseEnvironmentsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/environments',
  tags: ['Codebases'],
  summary: 'List isolation environments for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvironmentsResponseSchema } },
      description: 'List of isolation environments',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const getWebPushKeyRoute = createRoute({
  method: 'get',
  path: '/api/web-push/key',
  tags: ['Alerts'],
  summary: 'Browser push public key',
  responses: {
    200: {
      content: { 'application/json': { schema: webPushKeySchema } },
      description: 'VAPID public key',
    },
  },
});
const addWebPushRoute = createRoute({
  method: 'post',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser into push',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: webPushSubscriptionSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Subscribed',
    },
  },
});
const deleteWebPushRoute = createRoute({
  method: 'delete',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser out of push',
  request: {
    body: { required: true, content: { 'application/json': { schema: webPushDeleteSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Unsubscribed',
    },
  },
});

/**
 * Conversation concurrency as `GET /api/health` reports it: the lock manager's
 * stats, with `active` widened to include background workflow conversations.
 * `satisfies` ties the declared fields to `getStats()`, so a rename there fails
 * the type-check instead of reaching the console as a missing field.
 */
const healthConcurrencySchema = z.object({
  active: z.number(),
  queuedTotal: z.number(),
  queuedByConversation: z.array(
    z.object({ conversationId: z.string(), queuedMessages: z.number() })
  ),
  maxConcurrent: z.number(),
  activeConversationIds: z.array(z.string()),
}) satisfies z.ZodType<ReturnType<ConversationLockManager['getStats']>>;

const getHealthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z
            .object({
              status: z.string(),
              adapter: z.string(),
              concurrency: healthConcurrencySchema,
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              is_wsl: z.boolean(),
              wsl_distro: z.string().optional(),
              activePlatforms: z.array(z.string()).optional(),
              attentionDestinations: z
                .array(z.object({ id: z.string(), state: z.enum(PUSH_DESTINATION_STATES) }))
                .optional(),
              // Schema vintage (#2316) so a bug report can state which Archon build
              // created this database and which last applied schema to it. Omitted
              // when unrecorded or unreadable — health must answer regardless.
              schema: z
                .object({
                  createdAppVersion: z.string().nullable(),
                  appVersion: z.string(),
                  appliedAt: z.string().nullable(),
                })
                .optional(),
            })
            .openapi('HealthResponse'),
        },
      },
      description: 'Health status',
    },
  },
});

const getUpdateCheckRoute = createRoute({
  method: 'get',
  path: '/api/update-check',
  tags: ['System'],
  summary: 'Check for available updates',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateCheckResponseSchema,
        },
      },
      description: 'Update check result',
    },
  },
});

/**
 * Register all /api/* routes on the Hono app.
 */
export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[],
  attention?: { webPush: WebPushDestination; router: AttentionRouter },
  registration: Pick<CloneOptions, 'githubAppAuth'> = {}
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const {
    assertRunActionAllowed,
    signalWorkflowWait,
    deleteWorkflowRun,
    resumeWorkflow,
    abandonWorkflow,
    cancelWorkflow,
    approveWorkflow,
    rejectWorkflow,
    respondToWorkflow,
    answerWorkflow,
    labelAttentionWait,
    resetWorkflowNodeSessions,
  } = createSqlWorkflowOperations();
  const attentionQueue = attentionQueueSource(
    createWorkflowStore(),
    createWorkflowHostStore().isolation
  );

  app.openAPIRegistry.register('DagNodeSseEvent', dagNodeSseEventSchema);
  app.openAPIRegistry.register('WebPushPayload', webPushPayloadSchema);
  app.openAPIRegistry.register(RUN_ATTENTION_SCHEMA_NAME, runAttentionSchema);

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

  /**
   * Validate that a caller-supplied `cwd` is rooted at a registered codebase path.
   * This prevents path traversal — callers cannot read/write outside known project roots.
   */
  async function validateCwd(cwd: string): Promise<boolean> {
    const codebases = await codebaseDb.listCodebases();
    return codebases.some(cb =>
      isPathInside(cb.default_cwd, cwd, { includeRoot: true, lexical: true })
    );
  }

  // CORS for Web UI — allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  // Server-side access gate: when web auth is enabled (and not opted out via
  // ARCHON_WEB_AUTH_REQUIRED=false), every /api/* request must resolve to an
  // identity or get 401 — this is what makes Better Auth the real access
  // boundary so a reverse-proxy auth sidecar can retire. Public exceptions:
  //   - /api/auth/* — the login/status/device-flow surface (can't gate login)
  //   - /api/health* — the Docker/uptime healthcheck MUST stay reachable
  // /webhooks/* (HMAC-verified) and /internal/* (loopback-guarded) are outside
  // /api/* and untouched. No-op when web auth is disabled (solo/local unchanged).
  //
  // SECURITY: resolveAuthContext also accepts the trusted reverse-proxy header
  // (`webAuthHeaderName()`) as an identity. That header
  // is only safe to trust when the app is reachable solely through a proxy that
  // STRIPS it from inbound requests (or the app binds 127.0.0.1). If you retire
  // the proxy auth sidecar, the proxy MUST still strip that header — otherwise a
  // client can forge it and walk straight through this gate.
  const PUBLIC_API_GATE_PREFIXES = ['/api/auth/', '/api/health'];
  app.use('/api/*', async (c, next) => {
    if (!isApiGateEnabled()) return next();
    const path = c.req.path;
    if (PUBLIC_API_GATE_PREFIXES.some(p => path === p || path.startsWith(p))) return next();
    if (await resolveAuthContext(c)) return next();
    // Soft resolution reads an identity-backend outage as "signed out"; the strict
    // path tells the two apart so an outage is a 503, not a 401.
    const strict = await requireWebUser(c, 'Authentication required');
    return 'error' in strict ? strict.error : next();
  });

  registerAuthRoutes(app);
  registerProviderKeyRoutes(app);
  registerUserAiPrefsRoutes(app);

  const dispatchToOrchestrator = createOrchestratorDispatch(webAdapter, lockManager);
  registerConversationRoutes(app, { webAdapter, dispatchToOrchestrator });
  registerMessageRoutes(app, { webAdapter, dispatchToOrchestrator });

  /**
   * What happens after a gate answer is recorded. The routes never resume the run:
   * an answered pause that `continuablePause` admits is a due continuation, which the
   * server's continuation scheduler (or `workflow wake`) continues on the platform that
   * started the run. Anything else needs a manual resume.
   */
  function continuationNotice(run: WorkflowRun): string {
    return continuablePause(run) !== undefined
      ? 'The run continues on its own.'
      : `Run \`archon workflow resume ${run.id}\` from the CLI to continue it.`;
  }

  // GET /api/codebases - List codebases
  registerOpenApiRoute(listCodebasesRoute, async c => {
    try {
      const codebases = await codebaseDb.listCodebases();

      // Deduplicate by repository_url (keep most recently updated)
      const normalizeUrl = (url: string): string => url.replace(/\.git$/, '');
      const seen = new Map<string, (typeof codebases)[number]>();
      const deduped: (typeof codebases)[number][] = [];
      for (const cb of codebases) {
        if (!cb.repository_url) {
          deduped.push(cb);
          continue;
        }
        const key = normalizeUrl(cb.repository_url);
        const existing = seen.get(key);
        if (!existing || cb.updated_at > existing.updated_at) {
          seen.set(key, cb);
        }
      }
      deduped.push(...seen.values());
      deduped.sort((a, b) => a.name.localeCompare(b.name));

      return c.json(deduped.map(toApiCodebase));
    } catch (error) {
      getLog().error({ err: error }, 'list_codebases_failed');
      return apiError(c, 500, 'Failed to list codebases');
    }
  });

  // GET /api/codebases/:id - Codebase detail
  registerOpenApiRoute(getCodebaseRoute, async c => {
    try {
      const codebase = await codebaseDb.getCodebase(c.req.param('id') ?? '');
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }
      return c.json(toApiCodebase(codebase));
    } catch (error) {
      getLog().error({ err: error }, 'get_codebase_failed');
      return apiError(c, 500, 'Failed to get codebase');
    }
  });

  registerOpenApiRoute(inspectBaseBranchRoute, async c => {
    const body = getValidatedBody(c, inspectBaseBranchBodySchema);
    try {
      return c.json(await inspectProjectBaseBranch(body, registration), 200);
    } catch (error) {
      if (error instanceof ProjectRegistrationError) return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'inspect_base_branch_failed');
      return apiError(c, 500, `Failed to inspect base branch: ${(error as Error).message}`);
    }
  });

  // POST /api/codebases - Add a project (clone from URL or register local path)
  registerOpenApiRoute(addCodebaseRoute, async c => {
    const body = getValidatedBody(c, addCodebaseBodySchema);

    try {
      let result;
      if ('url' in body) {
        result = await cloneRepository(body.url, {
          ...registration,
          baseBranch: body.base_branch ?? undefined,
        });
      } else if (body.folder === true) {
        result = await registerFolder(body.path, undefined, {
          baseBranch: body.base_branch ?? undefined,
        });
      } else {
        const localPath = await canonicalizeProjectPath(body.path);
        const kind = await detectProjectKind(localPath);
        result =
          kind === 'repo'
            ? await registerRepository(localPath, { baseBranch: body.base_branch ?? undefined })
            : await registerFolder(localPath, undefined, {
                baseBranch: body.base_branch ?? undefined,
              });
      }

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return apiError(c, 500, 'Codebase created but not found');
      }

      return c.json(toApiCodebase(codebase), result.alreadyExisted ? 200 : 201);
    } catch (error) {
      if (error instanceof ProjectKindDetectionError) {
        getLog().warn({ err: error }, 'api.add_codebase_repo_detect_failed');
        return apiError(c, 500, error.message);
      }
      if (
        error instanceof ProjectRegistrationError ||
        error instanceof ConfiguredBaseBranchNotFoundError
      )
        return apiError(c, 400, error.message);
      getLog().error({ err: error }, 'add_codebase_failed');
      return apiError(
        c,
        500,
        `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}`
      );
    }
  });

  // PATCH /api/codebases/:id - Rename a project
  registerOpenApiRoute(renameCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    const { name } = getValidatedBody(c, renameCodebaseBodySchema);
    try {
      return c.json(toApiCodebase(await codebaseDb.renameCodebase(id, name)), 200);
    } catch (error) {
      if (error instanceof codebaseDb.CodebaseNotFoundError) {
        return apiError(c, 404, 'Codebase not found');
      }
      if (
        error instanceof codebaseDb.CodebaseNameTakenError ||
        error instanceof codebaseDb.CodebaseStorageIdentityChangeError
      ) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error, codebaseId: id }, 'rename_codebase_failed');
      return apiError(c, 500, 'Failed to rename codebase');
    }
  });

  // DELETE /api/codebases/:id - Delete a project and clean up
  registerOpenApiRoute(deleteCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebase(id);
      const containers = environments.filter(env => env.provider === 'container');
      if (containers.length > 0) {
        throw new ActiveContainerEnvironmentsError(containers.map(env => env.id));
      }
      for (const env of environments.filter(env => env.provider === 'worktree')) {
        try {
          const exists = await stat(env.working_path).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
              throw error;
            }
          );
          if (exists) {
            await removeWorktree(
              toRepoPath(codebase.default_cwd),
              toWorktreePath(env.working_path)
            );
          }
          if (await isWorktreeRegistered(toRepoPath(codebase.default_cwd), env.working_path)) {
            throw new Error('Checkout is still registered with Git');
          }
          await isolationEnvDb.markWorktreeDestroyed(env);
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          if (wtErr instanceof WorktreeRegistrationChangedError) {
            return apiError(c, 409, wtErr.message);
          }
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
          return apiError(
            c,
            500,
            `Failed to clean up worktree ${env.id}. Project kept; resolve the cleanup failure and retry deletion.`
          );
        }
      }

      await codebaseDb.deleteCodebase(id, { requireWorktreeCleanup: true });

      // Remove workspace directory from disk — only for Archon-managed repos
      const normalizedCwd = normalize(codebase.default_cwd);
      if (isInsideArchonWorkspaces(normalizedCwd)) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
          return apiError(
            c,
            500,
            `Project registration deleted, but workspace removal failed at ${normalizedCwd}. Remove this directory manually after resolving the filesystem error.`
          );
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
      if (
        error instanceof ActiveContainerEnvironmentsError ||
        error instanceof ActiveWorktreeEnvironmentsError
      ) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error }, 'delete_codebase_failed');
      return apiError(c, 500, 'Failed to delete codebase');
    }
  });

  // GET /api/codebases/:id/env - List env var keys for a codebase (values never returned)
  registerOpenApiRoute(listEnvVarsRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      const envVars = await envVarDb.getCodebaseEnvVars(id);
      return c.json({ keys: Object.keys(envVars) });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'list_env_vars_failed');
      return apiError(c, 500, 'Failed to list env vars');
    }
  });

  // PUT /api/codebases/:id/env - Set (upsert) an env var
  registerOpenApiRoute(setEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const body = getValidatedBody(c, setEnvVarBodySchema);
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.setCodebaseEnvVar(id, body.key, body.value);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'set_env_var_failed');
      return apiError(c, 500, 'Failed to set env var');
    }
  });

  // DELETE /api/codebases/:id/env/:key - Delete an env var
  registerOpenApiRoute(deleteEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    const key = c.req.param('key') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.deleteCodebaseEnvVar(id, key);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id, key }, 'delete_env_var_failed');
      return apiError(c, 500, 'Failed to delete env var');
    }
  });

  // Serve OpenAPI spec
  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  // GET /api/workflows - Discover available workflows
  registerOpenApiRoute(getWorkflowsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir: string | undefined = cwd;

      // Validate caller-supplied cwd against registered codebase paths
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        // Fallback to first codebase's default_cwd
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      // No project context (no cwd query param and no registered codebases) —
      // pass null to discovery so it returns bundled + home-scoped workflows.
      // This avoids a misleading empty state on first run, before any project
      // is registered, when bundled defaults are present
      const result = await discoverWorkflowsWithConfig(
        workingDir ?? null,
        loadConfig,
        providerRegistry
      );

      // Resolve repo-owner-curated recommended list (per-project only).
      // Filter to names present in the discovered set; preserve declared order.
      // Stale names are silently ignored (advisory).
      const recommended: string[] = [];
      if (workingDir) {
        const repoConfig = await loadRepoConfig(workingDir);
        const declared = repoConfig.recommendedWorkflows ?? [];
        if (declared.length > 0) {
          const discoveredNames = new Set(result.workflows.map(ws => ws.workflow.name));
          const seen = new Set<string>();
          for (const name of declared) {
            if (discoveredNames.has(name) && !seen.has(name)) {
              recommended.push(name);
              seen.add(name);
            } else if (!discoveredNames.has(name)) {
              getLog().debug({ workingDir, name }, 'workflows.recommended_workflow_not_found');
            }
          }
        }
      }

      return c.json({
        workflows: result.workflows.map(ws => ({
          // Display shows what the AUTHOR wrote. Composition collapses workflow-level
          // node config onto the nodes and removes it (#1764), so the declared values are
          // layered back over the definition for this listing only — the console reads
          // `workflow.provider` to label a card, and execution never reads this response.
          workflow: Object.assign({}, ws.workflow, ws.declared),
          source: ws.source,
          // Keys the engine dropped from this YAML (#2213) — the console is the
          // surface most authors edit workflows on, so it has to carry them.
          ...(ws.parseWarnings && ws.parseWarnings.length > 0
            ? { parseWarnings: [...ws.parseWarnings] }
            : {}),
        })),
        recommended,
        errors:
          result.errors.length > 0
            ? result.errors.map(error => workflowLoadErrorSchema.parse(error))
            : undefined,
      });
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted — return empty with warning
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_discovery_failed');
      return apiError(c, 500, `Workflow discovery failed: ${err.message}`);
    }
  });

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

    let message: string;
    let conversationId: string;
    let workflowInputs: Record<string, string> | undefined;
    let workflowModelOverrides: RunModelOverrides | undefined;
    let workflowRunConfig: WorkflowRunConfigInput | undefined;
    // Between-run continuation (#2747): run-id only — no name-based newest-wins.
    let adoptRunId: string | undefined;
    let supersedesRunId: string | undefined;
    let fileEntries: File[] = [];

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr }, 'run_workflow.multipart_parse_failed');
        return apiError(c, 400, 'Invalid multipart form data');
      }

      const rawMessage = body.message;
      const rawConv = body.conversationId;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (typeof rawConv !== 'string' || !rawConv || !/^[\w-]+$/.test(rawConv)) {
        return apiError(c, 400, 'conversationId must be a non-empty alphanumeric string');
      }
      message = rawMessage;
      conversationId = rawConv;

      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }

      // Declared inputs (#2554). A form field can only be a string, so the map travels
      // JSON-encoded. A malformed field is refused rather than ignored — silently
      // dropping it would start the run without the values the caller thought it sent.
      const rawInputs = body.inputs;
      if (rawInputs !== undefined) {
        if (typeof rawInputs !== 'string') {
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawInputs);
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.inputs_parse_failed');
          return apiError(c, 400, 'inputs must be a JSON-encoded object of string values');
        }
        const parsed = parseRunInputsField(decoded);
        if (!parsed.ok) return apiError(c, 400, parsed.error);
        workflowInputs = parsed.inputs;
      }

      const decodeObjectField = (
        raw: string | File | (string | File)[] | undefined,
        label: 'tiers' | 'aliases'
      ): { ok: true; value?: unknown } | { ok: false; error: string } => {
        if (raw === undefined) return { ok: true };
        if (typeof raw !== 'string') {
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
        try {
          return { ok: true, value: JSON.parse(raw) as unknown };
        } catch (parseErr: unknown) {
          getLog().warn(
            { err: parseErr, workflowName, field: label },
            'run_workflow.model_overrides_parse_failed'
          );
          return { ok: false, error: `${label} must be a JSON-encoded object` };
        }
      };
      const decodedTiers = decodeObjectField(body.tiers, 'tiers');
      if (!decodedTiers.ok) return apiError(c, 400, decodedTiers.error);
      const decodedAliases = decodeObjectField(body.aliases, 'aliases');
      if (!decodedAliases.ok) return apiError(c, 400, decodedAliases.error);
      const parsedOverrides = parseRunModelOverridesFields(
        decodedTiers.value,
        decodedAliases.value
      );
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;

      if (body.config !== undefined) {
        if (typeof body.config !== 'string') {
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        let decodedConfig: unknown;
        try {
          decodedConfig = JSON.parse(body.config) as unknown;
        } catch (parseErr: unknown) {
          getLog().warn({ err: parseErr, workflowName }, 'run_workflow.config_parse_failed');
          return apiError(c, 400, 'config must be a JSON-encoded object');
        }
        try {
          workflowRunConfig = parseWorkflowRunConfig(decodedConfig, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }

      const rawFiles = body.files;
      const fileList: (string | File)[] = Array.isArray(rawFiles)
        ? rawFiles
        : rawFiles !== undefined
          ? [rawFiles]
          : [];
      fileEntries = fileList.filter((e): e is File => e instanceof File);
    } else {
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
        return apiError(c, 400, 'Invalid JSON in request body');
      }
      if (typeof body.conversationId !== 'string' || !body.conversationId) {
        return apiError(c, 400, 'conversationId must be a non-empty string');
      }
      if (typeof body.message !== 'string' || !body.message) {
        return apiError(c, 400, 'message must be a non-empty string');
      }
      if (body.configPath !== undefined) {
        return apiError(c, 400, 'configPath is not supported; send validated config content');
      }
      const parsed = parseRunInputsField(body.inputs);
      if (!parsed.ok) return apiError(c, 400, parsed.error);
      workflowInputs = parsed.inputs;
      for (const [field, target] of [
        ['adopt_run_id', 'adopt'],
        ['supersedes_run_id', 'supersede'],
      ] as const) {
        const raw = body[field];
        if (raw === undefined) continue;
        if (typeof raw !== 'string' || !raw) {
          return apiError(c, 400, `${field} must be a non-empty run id`);
        }
        if (target === 'adopt') adoptRunId = raw;
        else supersedesRunId = raw;
      }
      if (adoptRunId && supersedesRunId) {
        return apiError(c, 400, 'adopt_run_id and supersedes_run_id are mutually exclusive');
      }
      const parsedOverrides = parseRunModelOverridesFields(body.tiers, body.aliases);
      if (!parsedOverrides.ok) return apiError(c, 400, parsedOverrides.error);
      workflowModelOverrides = parsedOverrides.overrides;
      if (body.config !== undefined) {
        try {
          workflowRunConfig = parseWorkflowRunConfig(body.config, {
            kind: 'http',
            label: 'inline',
          });
        } catch (error) {
          return apiError(c, 400, (error as Error).message);
        }
      }
      conversationId = body.conversationId;
      message = body.message;
    }

    // The conversation id arrives in the body, so attachments are written only
    // once it is known that the caller may reach this conversation.
    const access = await authorizeDispatchConversation(c, conversationId);
    if ('error' in access) return access.error;
    const conv = access.conversation;
    const actor = access.actor;
    const userId = actor.kind === 'user' ? actor.userId : undefined;

    let savedFiles: AttachedFile[] = [];
    if (fileEntries.length > 0) {
      const result = await persistUploadedFiles(conversationId, fileEntries);
      if (!result.ok) {
        return apiError(c, result.status, result.error);
      }
      savedFiles = result.savedFiles;
      getLog().info(
        { conversationId, fileCount: savedFiles.length, workflowName },
        'run_workflow.files_uploaded'
      );
    }

    try {
      // Persist user message and register DB ID (same as message endpoint).
      // File metadata (name/mime/size — no path, since the on-disk file is
      // ephemeral) goes into message metadata when present.
      if (conv) {
        try {
          const meta =
            savedFiles.length > 0
              ? {
                  files: savedFiles.map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    size: f.size,
                  })),
                }
              : undefined;
          await messageDb.addMessage(conv.id, 'user', message, meta, userId);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
          for (const file of savedFiles) {
            await unlink(file.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn(
                  { err, filePath: file.path, conversationId },
                  'upload.rollback_failed'
                );
              }
            });
          }
          return apiError(c, 500, 'Failed to save workflow request to history');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        if (!conv.title) {
          // Resolve the `small` tier (config tiers + per-user prefs) instead of the raw
          // assistant default (#1855). Both calls never throw.
          void resolveTitleRequest(conv.ai_assistant_type, userId).then(titleRequest =>
            generateTitleForUser(
              conv.id,
              message,
              titleRequest,
              getArchonWorkspacesPath(),
              userId,
              workflowName
            )
          );
        }
      }

      // The message and every run option ride typed fields, never a chat command
      // string: tokenizing the message would rewrite it and let a word in it set
      // `--force` (#4159), and encoding inputs would invent a chat grammar (#2554/#2555).
      const extraContext: Omit<HandleMessageContext, 'isolationHints'> = {
        actor,
        workflowName,
        ...(savedFiles.length > 0 ? { attachedFiles: savedFiles } : {}),
        ...(workflowInputs ? { workflowInputs } : {}),
        ...(workflowModelOverrides ? { workflowModelOverrides } : {}),
        ...(workflowRunConfig ? { workflowRunConfig } : {}),
        ...(adoptRunId ? { workflowAdoptRunId: adoptRunId } : {}),
        ...(supersedesRunId ? { workflowSupersedesRunId: supersedesRunId } : {}),
      };
      const filesToCleanup = savedFiles.length > 0 ? savedFiles : undefined;
      const result = await dispatchToOrchestrator(
        conversationId,
        message,
        extraContext,
        filesToCleanup
      );
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return apiError(c, 500, 'Failed to run workflow');
    }
  });

  // GET /api/runs/attention - The attention queue. A server has no working directory, so
  // without `project` the scope is the whole install.
  registerOpenApiRoute(getRunsNeedingAttentionRoute, async c => {
    try {
      const query = getValidatedQuery(c, attentionQueueQuerySchema);
      const label = query.label ?? [];
      let scope: AttentionQueueScope;
      let request: ReturnType<typeof parseAttentionQueueRequest>;
      try {
        request = parseAttentionQueueRequest({
          ...query,
          all: query.all === 'true',
          labels: typeof label === 'string' ? [label] : label,
        });
        scope =
          query.project === undefined
            ? { kind: 'all' }
            : {
                kind: 'project',
                project: await resolveAttentionProject(codebaseDb, query.project),
              };
      } catch (refusal) {
        return apiError(c, 400, (refusal as Error).message);
      }
      // One read backs both the items and the console's dashboard rows for the same runs.
      const rows = await workflowDb.listAttentionQueueRows();
      const items = await attentionQueueItems(attentionQueue, rows);
      const { labels, order, countBy } = request;
      if (countBy !== undefined)
        return c.json({ counts: countAttentionQueue(items, { scope, labels, countBy }) });
      const selected = selectAttentionQueue(items, { scope, labels, order });
      const ids = new Set(selected.map(item => item.runId));
      const runs = rows.filter(run => ids.has(run.id));
      return c.json({ runs: runs.map(toApiDashboardWorkflowRun), items: selected });
    } catch (error) {
      getLog().error({ err: error }, 'list_runs_needing_attention_failed');
      return apiError(c, 500, 'Failed to list runs needing attention');
    }
  });

  // GET /api/runs/:runId/attention - The item a run stands for; a parent blocked on
  // sub-runs resolves to its child's item.
  registerOpenApiRoute(getRunAttentionItemRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const item = await readAttentionQueueItem(attentionQueue, runId);
      if (item === undefined) return apiError(c, 404, 'Workflow run not found');
      return c.json({ item });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.run_attention_item_failed');
      return apiError(c, 500, 'Failed to read the attention queue item');
    }
  });

  // POST /api/runs/:runId/attention/labels - Merge a label write into the open attention wait.
  registerOpenApiRoute(labelRunAttentionRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'respond');
      const body = getValidatedBody(c, labelAttentionBodySchema);
      const request = { occurrence: body.occurrence, set: body.set ?? {}, unset: body.unset ?? [] };
      try {
        assertLabelable(run, request, 'api');
      } catch (refusal) {
        if (refusal instanceof StaleGateAnswerError) return apiError(c, 409, refusal.message);
        return apiError(c, 400, (refusal as Error).message);
      }
      return c.json(await labelAttentionWait(runId, request, actor, 'api'));
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      // A race lost after the pre-check above: the run moved to another pause meanwhile.
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.run_attention_label_failed');
      return apiError(c, 500, 'Failed to label the attention wait');
    }
  });

  // GET /api/dashboard/runs - Enriched workflow runs for Command Center
  // Supports server-side search, status/date filtering, and offset pagination.
  registerOpenApiRoute(getDashboardRunsRoute, async c => {
    try {
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type DashboardRunStatus = (typeof validStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      const offsetRaw = Number(c.req.query('offset'));
      const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

      const result = await workflowDb.listDashboardRuns({
        status,
        codebaseId,
        search,
        after,
        before,
        limit,
        offset,
      });
      return c.json({
        ...result,
        runs: result.runs.map(toApiDashboardWorkflowRun),
      });
    } catch (error) {
      getLog().error({ err: error }, 'list_dashboard_runs_failed');
      return apiError(c, 500, 'Failed to list dashboard runs');
    }
  });

  // POST /api/workflows/runs/:runId/cancel - Cancel a workflow run through the shared
  // owner-checked cancel: cooperative for a run this server executes, an owner stop for
  // one another process owns, and a 409 refusal when no owner answers.
  registerOpenApiRoute(cancelWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const result = await cancelWorkflow(runId, await resolveRunActor(c));
      if (result.kind === 'cooperative') {
        return c.json({
          success: true,
          message: result.cancelled
            ? `Cancelled workflow: ${run.workflow_name}`
            : `Workflow ${run.workflow_name} already finished — nothing to cancel.`,
        });
      }
      let message = `Stopped the run's live owner process (pid ${String(result.pid)}), then cancelled workflow: ${run.workflow_name}`;
      for (const warning of result.cleanupWarnings ?? []) message += ` — warning: ${warning}`;
      if (result.cascadeFailures > 0) {
        message += ` — warning: ${String(result.cascadeFailures)} sub-run(s) could not be cancelled and may still be running`;
      }
      if (result.blockedParentRunId) {
        message += ` — parent run ${result.blockedParentRunId} was blocked on this sub-run and stays paused; resume it so it reads this sub-run's outcome, or abandon it too`;
      }
      return c.json({ success: true, message });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      if (error instanceof CancelRefusedError) {
        return apiError(c, error.reason === 'not_running' ? 400 : 409, error.message);
      }
      getLog().error({ err: error, runId }, 'cancel_workflow_run_api_failed');
      return apiError(c, 500, 'Failed to cancel workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/resume - Resume a workflow run
  registerOpenApiRoute(resumeWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'resume');
      if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot resume workflow in '${run.status}' status`);
      }
      await resumeWorkflow(runId, actor);
      // Dispatch resume by sending `/workflow resume <id>` to the parent web
      // conversation; the command handler validates the run and hands the
      // orchestrator a resume request carrying that run. Explicit targeting (not
      // a bare `/workflow run <name>`) so a genuinely-failed run resumes
      // directly instead of hitting the disambiguation prompt (#2075).
      if (!run.parent_conversation_id) {
        // No parent conversation to dispatch a chat message through at all —
        // every CLI-launched run (#2008). Execute directly instead of 400ing.
        const headless = await resumeWorkflowRunFromServer(
          createSqlWorkflowHost(),
          run,
          actor.kind === 'user' ? actor.userId : undefined
        );
        if (headless.kind === 'waiting_for_capacity' || headless.kind === 'resource_busy')
          return apiError(c, 409, headless.message);
        if (headless.kind === 'not_resumed') {
          return apiError(
            c,
            400,
            `This run was created outside the web UI. Use \`archon workflow resume ${runId}\` from the CLI to resume it.`
          );
        }
        getLog().info(
          { runId, workflowName: run.workflow_name },
          'api.workflow_run_resume_headless_dispatched'
        );
        return c.json({
          success: true,
          message: `Resuming workflow: ${run.workflow_name}`,
        });
      }
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      if (!parentConv?.platform_conversation_id || parentConv.platform_type !== 'web') {
        return apiError(
          c,
          400,
          `Cannot resume from web UI: the run's parent conversation is not a web conversation. Use \`archon workflow resume ${runId}\` from the CLI.`
        );
      }
      const resumeMessage = `/workflow resume ${run.id}`;
      // Resume executes as the user who clicked resume (sender-first, #1982),
      // not the conversation creator. Undefined on solo installs → fallback.
      await dispatchToOrchestrator(parentConv.platform_conversation_id, resumeMessage, {
        actor,
      });
      getLog().info(
        {
          runId,
          workflowName: run.workflow_name,
          platformConvId: parentConv.platform_conversation_id,
        },
        'api.workflow_run_resume_dispatched'
      );
      return c.json({
        success: true,
        message: `Resuming workflow: ${run.workflow_name}`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_resume_failed');
      return apiError(c, 500, 'Failed to resume workflow run');
    }
  });

  registerOpenApiRoute(signalWorkflowWaitRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    const request = getValidatedBody(c, signalWorkflowWaitRequestSchema);
    const { event } = request;
    try {
      const store = createWorkflowStore();
      const run = await store.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      const { signaled } = await signalWorkflowWait(runId, request, await resolveRunActor(c));
      if (!signaled) {
        return apiError(c, 400, `Run is not waiting on event '${event}'`);
      }
      return c.json({
        success: true,
        message: `Signaled '${event}'. The workflow will resume shortly.`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      getLog().error({ err: error, runId, event }, 'signal_workflow_wait_api_failed');
      return apiError(c, 500, 'Failed to signal workflow wait');
    }
  });

  // POST /api/workflows/runs/:runId/abandon - Abandon a workflow run
  registerOpenApiRoute(abandonWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const { cascadeFailures, cleanupWarnings, releasedWorktrees, blockedParentRunId, owner } =
        await abandonWorkflow(runId, await resolveRunActor(c));
      let message = [
        ...describeAbandonOwner(owner),
        `Abandoned workflow: ${run.workflow_name}`,
        ...describeReleasedWorktrees(releasedWorktrees),
      ].join(' ');
      for (const warning of cleanupWarnings ?? []) message += ` — warning: ${warning}`;
      if (cascadeFailures > 0) {
        message += ` — warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running`;
      }
      if (blockedParentRunId) {
        message += ` — parent run ${blockedParentRunId} was blocked on this sub-run and stays paused; resume it so it reads this sub-run's outcome, or abandon it too`;
      }
      return c.json({ success: true, message });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      if (error instanceof AbandonOwnerNotStoppedError || error instanceof AbandonRefusedError) {
        return apiError(c, 409, error.message);
      }
      getLog().error({ err: error, runId }, 'api.workflow_run_abandon_failed');
      return apiError(c, 500, 'Failed to abandon workflow run');
    }
  });

  /**
   * The approve / reject / respond routes' shared precondition, expressed as one
   * `runAttention` read mapped to this surface's 400s. Returns null when the route may
   * go on to resolve the gate.
   *
   * `requireReadableGate` mirrors the core split (`assertApprovable` vs
   * `assertRejectable`): approve refuses a run whose gate metadata cannot be read,
   * while reject and respond still resolve it — they fall back to
   * `approval?.nodeId ?? 'unknown'` for the audit event.
   *
   * The operations throw the same conclusions; mapping them here gives the console the
   * message instead of an opaque 500.
   */
  function pausedGateBlocker(
    run: WorkflowRun,
    childRedirectAdvice: string,
    requireReadableGate: boolean
  ): GateRefusal | null {
    const attention = runAttention(run);
    const approvalRaw = run.metadata.approval;
    const approval = isApprovalContext(approvalRaw) ? approvalRaw : undefined;
    switch (attention?.kind) {
      case 'attention':
        // The route answers it as sugar; `answerRefusal` judges the answer.
        return null;
      case 'blocked_on_child':
        // Not an approvable gate — the parent resumes automatically when the child
        // completes. Send the caller to the run where the decision actually lives.
        return {
          error: `Run is paused waiting on sub-run ${attention.childRunId}. ${childRedirectAdvice}`,
          childRunId: attention.childRunId,
        };
      case 'blocked_on_children':
        // A fan-out waits on several children; there is no single run to send the
        // caller to, so the message names them all.
        return {
          error:
            `Run is paused waiting on the sub-runs of fan-out node '${attention.nodeId}': ` +
            `${attention.childRunIds.join(', ')}. Answer each paused sub-run by its own run id; ` +
            'this run continues when they finish.',
        };
      case 'unreadable':
        if (attention.reason === 'malformed_gate') {
          return requireReadableGate
            ? { error: 'Workflow run is paused but missing approval context' }
            : null;
        }
        if (attention.reason === 'unrecognized_gate_type') {
          return {
            error: `Workflow run has an unrecognized gate type '${String(approval?.type)}' — this Archon build cannot resolve it`,
          };
        }
        return { error: `Workflow run cannot be resolved: ${attention.detail}` };
      case undefined:
        // Post-#2075 the run stays 'paused' after a resolution, so status alone no
        // longer distinguishes "awaiting a response" from "awaiting resume".
        if (approval && isGateResolved(approval)) {
          return {
            error: `Workflow run was already ${String(approval.resolved)} — resume in progress`,
          };
        }
        // Paused with no gate at all — a durable `wait:`. There is nothing to approve.
        return requireReadableGate
          ? { error: 'Workflow run is paused but missing approval context' }
          : null;
      case 'awaiting_response':
        // The gate is open and this route may go on to resolve it.
        return null;
      case 'usage_limit':
        return {
          error:
            `Run hit a provider usage or rate limit and tries again by itself at ` +
            `${attention.resumeAt}; it has no gate to resolve.`,
        };
      case 'stalled_tool_calls':
      case 'terminal':
        // Unreachable: every route checks `status !== 'paused'` before calling this.
        return null;
      default: {
        // Exhaustive by construction, so a fifth `RunAttention` kind becomes a compile
        // error here instead of a silently swallowed one — which is how this route
        // would reintroduce the opaque 500 the precondition exists to remove. The
        // other three consumers of the union already fail to compile the same way.
        const unreachable: never = attention;
        throw new Error(`pausedGateBlocker: unhandled attention ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Why `decision` cannot answer the run's open pause, or null when it can. */
  function answerRefusal(run: WorkflowRun, decision: string): string | null {
    try {
      assertResponseAccepted(run, decision);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  // POST /api/workflows/runs/:runId/approve - Approve a paused workflow run
  registerOpenApiRoute(approveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'approve');
      const rawBody = await c.req.text();
      let input: unknown;
      try {
        input = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
      } catch {
        return apiError(c, 400, 'Request body is not valid JSON');
      }
      const parsed = approveWorkflowRunBodySchema.safeParse(input);
      if (!parsed.success) return apiError(c, 400, parsed.error.message);
      const body = parsed.data;
      const origin: GateAnswerOrigin = { via: 'api', expectedGate: body.expectedGate };
      assertAnswerAdmissible(run, origin);
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot approve workflow in '${run.status}' status`);
      }
      const approveBlocker = pausedGateBlocker(
        run,
        'Approve or reject the child run instead.',
        true
      );
      if (approveBlocker) {
        return c.json(approveBlocker, 400);
      }
      const approveRefusal = answerRefusal(run, 'approve');
      if (approveRefusal !== null) return apiError(c, 400, approveRefusal);
      // Shared gate logic (events, telemetry, metadata staging) — the run stays
      // 'paused' with metadata.approval.resolved = 'approved' (#2075). The
      // pre-checks above map the common error cases to 400s; approveWorkflow
      // re-validates and the atomic resolution checks the expected gate again.
      // The raw (possibly undefined) comment is passed through — approveWorkflow
      // defaults the recorded comment internally, but "no feedback" must survive
      // so a signal-bearing interactive-loop gate finalizes instead of re-running
      // (#2074, loop_feedback_given).
      await approveWorkflow(runId, body.comment, actor, origin);

      return c.json({
        success: true,
        message: `Workflow approved: ${run.workflow_name}. ${continuationNotice(run)}`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_approve_failed');
      return apiError(c, 500, 'Failed to approve workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/reject - Reject a paused workflow run
  registerOpenApiRoute(rejectWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'reject');
      const rawBody = await c.req.text();
      let input: unknown;
      try {
        input = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
      } catch {
        return apiError(c, 400, 'Request body is not valid JSON');
      }
      const parsed = rejectWorkflowRunBodySchema.safeParse(input);
      if (!parsed.success) return apiError(c, 400, parsed.error.message);
      const body = parsed.data;
      const origin: GateAnswerOrigin = { via: 'api', expectedGate: body.expectedGate };
      assertAnswerAdmissible(run, origin);
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot reject workflow in '${run.status}' status`);
      }
      const rejectBlocker = pausedGateBlocker(
        run,
        'Reject the child run instead, or abandon this run to discard the whole tree.',
        false
      );
      if (rejectBlocker) {
        return c.json(rejectBlocker, 400);
      }
      const rejectRefusal = answerRefusal(run, 'reject');
      if (rejectRefusal !== null) return apiError(c, 400, rejectRefusal);
      // Shared gate logic (events, telemetry, staging/cancel decision). When an
      // on_reject rework is staged the run stays 'paused' with
      // metadata.approval.resolved = 'rejected' (#2075).
      const result = await rejectWorkflow(runId, body.reason, actor, origin);

      if (result.cancelled) {
        return c.json({
          success: true,
          message: result.maxAttemptsReached
            ? `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`
            : `Workflow rejected: ${run.workflow_name}`,
        });
      }

      return c.json({
        success: true,
        message: result.newMode
          ? `Workflow rejected: ${run.workflow_name}. ${continuationNotice(run)}`
          : `Workflow rejected: ${run.workflow_name}. The on-reject prompt runs when the run continues. ${continuationNotice(run)}`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_reject_failed');
      return apiError(c, 500, 'Failed to reject workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/respond - Resolve a paused workflow run with any
  // declared decision (#2707 step 2). 'approve'/'reject' produce the exact same
  // resolution as the dedicated routes above — respondToWorkflow delegates those two
  // ids to the same approveWorkflow/rejectWorkflow functions.
  registerOpenApiRoute(respondWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'respond');
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot respond to workflow in '${run.status}' status`);
      }
      const respondBlocker = pausedGateBlocker(
        run,
        'Respond on the child run instead, or abandon this run to discard the whole tree.',
        false
      );
      if (respondBlocker) {
        return c.json(respondBlocker, 400);
      }
      const body = getValidatedBody(c, respondWorkflowRunBodySchema);
      const decision = body.decision;
      const origin: GateAnswerOrigin = {
        via: 'api',
        ...(body.expectedGate !== undefined ? { expectedGate: body.expectedGate } : {}),
      };

      // A stale occurrence is reported before the current gate judges the decision: the
      // caller answered an earlier pause and must hear that, not "undeclared decision".
      try {
        assertAnswerAdmissible(run, origin);
      } catch (staleError) {
        if (staleError instanceof StaleGateAnswerError) return apiError(c, 409, staleError.message);
        throw staleError;
      }

      const respondRefusal = answerRefusal(run, decision);
      if (respondRefusal !== null) return apiError(c, 400, respondRefusal);

      const result = await respondToWorkflow(runId, decision, body.text, actor, origin);

      if ('cancelled' in result && result.cancelled) {
        return c.json({
          success: true,
          message: result.maxAttemptsReached
            ? `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`
            : `Workflow rejected: ${run.workflow_name}`,
        });
      }

      return c.json({
        success: true,
        message: `Workflow responded '${decision}': ${run.workflow_name}. ${continuationNotice(run)}`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      // A race lost after the pre-check above: the run moved to another pause meanwhile.
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_respond_failed');
      return apiError(c, 500, 'Failed to respond to workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/answer - Answer a paused attention wait. The answer is
  // a due continuation, which a continuation host continues.
  registerOpenApiRoute(answerWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'respond');
      const body = getValidatedBody(c, answerWorkflowRunBodySchema);
      const origin: GateAnswerOrigin = {
        via: 'api',
        expectedGate: expectedGateForOccurrence(run, body.occurrence),
      };
      const request = {
        choose: body.choose ?? [],
        ...(body.text !== undefined ? { text: body.text } : {}),
      };
      try {
        assertAnswerAdmissible(run, origin);
        attentionAnswerFor(run, assertAnswerable(run), request);
      } catch (refusal) {
        if (refusal instanceof StaleGateAnswerError) return apiError(c, 409, refusal.message);
        return apiError(c, 400, (refusal as Error).message);
      }
      await answerWorkflow(runId, request, actor, origin);
      return c.json({
        success: true,
        message: `Workflow answered: ${run.workflow_name}. ${continuationNotice(run)}`,
      });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      // A race lost after the pre-check above: the run moved to another pause meanwhile.
      if (error instanceof StaleGateAnswerError) return apiError(c, 409, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_answer_failed');
      return apiError(c, 500, 'Failed to answer workflow run');
    }
  });

  // DELETE /api/workflows/runs/:runId - Delete a workflow run
  registerOpenApiRoute(deleteWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const actor = await resolveRunActor(c);
      await assertRunActionAllowed(run, actor, 'delete');
      if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(
          c,
          400,
          `Cannot delete workflow in '${run.status}' status — cancel it first`
        );
      }
      await deleteWorkflowRun(runId, actor);
      return c.json({ success: true, message: `Deleted workflow run: ${run.workflow_name}` });
    } catch (error) {
      if (error instanceof RunActionForbiddenError) return apiError(c, 403, error.message);
      getLog().error({ err: error, runId }, 'api.workflow_run_delete_failed');
      return apiError(c, 500, 'Failed to delete workflow run');
    }
  });

  // DELETE /api/workflows/:name/node-sessions - Reset persisted per-node provider sessions
  registerOpenApiRoute(resetWorkflowNodeSessionsRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!workflowName) {
      return apiError(c, 400, 'Workflow name is required');
    }
    const scope = c.req.query('scope') ?? undefined;
    const node = c.req.query('node') ?? undefined;
    const confirm = c.req.query('confirm') ?? undefined;
    // Cross-scope reset (no scope) is destructive — require explicit confirmation so a
    // dropped `scope` param can't silently wipe every conversation's sessions. Mirrors
    // the CLI `--yes` guard.
    if (scope === undefined && confirm !== 'all-scopes') {
      return apiError(
        c,
        400,
        'Refusing to reset sessions across all scopes without confirmation. Pass ?scope=<key> to narrow, or ?confirm=all-scopes to confirm.'
      );
    }
    try {
      // A scope key is a conversation's internal id. Under enforcement it is
      // authorized like any other conversation route, and the all-scopes reset, which reaches every user's
      // conversations at once, is not offered.
      if (isConversationOwnershipEnforced()) {
        if (scope === undefined) {
          return apiError(
            c,
            403,
            'Resetting sessions across all scopes is not available while conversations are private. Pass ?scope=<conversation id> to reset one conversation.'
          );
        }
        const access = await authorizeConversation(c, { id: scope }, 'write');
        if ('error' in access) return access.error;
      }
      const { deleted } = await resetWorkflowNodeSessions({
        workflow_name: workflowName,
        scope_key: scope,
        node_id: node,
      });
      return c.json({ success: true, deleted });
    } catch (error) {
      getLog().error(
        { err: error, workflowName, scope, node },
        'api.workflow_reset_node_sessions_failed'
      );
      return apiError(c, 500, 'Failed to reset workflow node sessions');
    }
  });

  // GET /api/workflows/runs - List workflow runs
  registerOpenApiRoute(listWorkflowRunsRoute, async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = workflowRunStatusSchema.options;
      type WorkflowRunStatus = (typeof validStatuses)[number];
      const status: WorkflowRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as WorkflowRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      // Non-enforcing "mine" filter: only narrows when an identity resolves.
      // Default visibility stays open (everyone sees everyone's runs).
      const mine = c.req.query('mine') === 'true';
      const userId = mine ? (await resolveAuthContext(c))?.userId : undefined;

      // Open-work inbox (#2747): a status-derived query, not a stored flag —
      // terminal failed runs with no adopter/successor. Mutually exclusive with
      // the other filters by contract; the inbox wins when combined.
      if (c.req.query('open') === 'true') {
        const openRuns = await workflowDb.findOpenWorkRuns({ codebaseId, limit });
        return c.json({ runs: openRuns.map(toApiWorkflowRun) });
      }

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
        userId,
      });
      return c.json({ runs: runs.map(toApiWorkflowRun) });
    } catch (error) {
      getLog().error({ err: error }, 'list_workflow_runs_failed');
      return apiError(c, 500, 'Failed to list workflow runs');
    }
  });

  // GET /api/workflows/runs/by-worker/:platformId - Look up run by worker conversation
  // Must be registered before :runId to avoid "by-worker" matching as a runId
  registerOpenApiRoute(getWorkflowRunByWorkerRoute, async c => {
    try {
      const platformId = c.req.param('platformId') ?? '';
      const run = await workflowDb.getWorkflowRunByWorkerPlatformId(platformId);
      if (!run) {
        return apiError(c, 404, 'No workflow run found for this worker');
      }
      return c.json({ run: toApiWorkflowRun(run) });
    } catch (error) {
      getLog().error({ err: error }, 'workflow_run_by_worker_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
  });

  // GET /api/workflows/runs/:runId - Get run details with events
  registerOpenApiRoute(getWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      // Provider events are served by their own route, per node; a long run has
      // thousands and they would dominate this payload.
      const events = await workflowEventDb.listWorkflowEvents(runId, {
        excludeEventTypes: workflowEventDb.PROVIDER_EVENT_ROW_TYPES,
      });

      // Look up the run's conversation platform ID.
      // For web runs (parent_conversation_id set): conversation_id is the worker conversation → set worker_platform_id
      // For CLI runs (no parent): conversation_id is the single conversation → set conversation_platform_id only
      let workerPlatformId: string | undefined;
      let conversationPlatformId: string | undefined;
      if (run.conversation_id) {
        const conv = await conversationDb.getConversationById(run.conversation_id);
        if (run.parent_conversation_id) {
          // Web run: conversation_id points to the worker conversation
          workerPlatformId = conv?.platform_conversation_id;
        } else {
          // CLI run: conversation_id is the only conversation (no worker/parent split)
          conversationPlatformId = conv?.platform_conversation_id;
        }
      }

      // Look up parent conversation to get its platform_conversation_id for navigation
      let parentPlatformId: string | undefined;
      if (run.parent_conversation_id) {
        const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
        parentPlatformId = parentConv?.platform_conversation_id;
      }

      const terminalRecord = getTerminalRecord(run.status, events);
      return c.json({
        run: {
          ...toApiWorkflowRun(run),
          worker_platform_id: workerPlatformId,
          parent_platform_id: parentPlatformId,
          conversation_platform_id: conversationPlatformId ?? null,
          terminal_record: terminalRecord,
          // The console reads node state from here and keeps no fold of its own.
          nodes: terminalRecord?.nodes ?? buildRunNodeStates(run, events),
        },
        // The console renders each cost's scope from here and keeps no copy of the rule.
        events: events.map(event =>
          typeof event.data.cost_usd === 'number'
            ? { ...event, cost_scope: nodeCostScope(event.data) }
            : event
        ),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return apiError(c, 500, 'Failed to get workflow run');
    }
  });

  // GET /api/workflows/runs/:runId/provider-events - A run's provider events
  registerOpenApiRoute(getProviderEventsRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    const { step, attemptId, afterSeq } = (
      c.req as unknown as { valid(k: 'query'): z.infer<typeof providerEventsQuerySchema> }
    ).valid('query');
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) return apiError(c, 404, 'Workflow run not found');
      // Read through the engine's store seam, not the DB module.
      const events = await createWorkflowStore().listProviderEvents(
        runId,
        step !== undefined && attemptId !== undefined && afterSeq !== undefined
          ? { stepName: step, after: { attemptId, seq: afterSeq } }
          : { stepName: step }
      );
      return c.json({ events });
    } catch (error) {
      getLog().error({ err: error, runId }, 'list_provider_events_failed');
      return apiError(c, 500, 'Failed to list provider events');
    }
  });

  // POST /api/workflows/validate - Validate a workflow definition without saving
  // MUST be registered before GET /api/workflows/:name so "validate" is not treated as :name
  registerOpenApiRoute(validateWorkflowRoute, async c => {
    const { definition } = getValidatedBody(c, validateWorkflowBodySchema);

    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    try {
      const result = parseWorkflow(yamlContent, 'validate-input.yaml', providerRegistry);

      if (result.error) {
        return c.json({ valid: false, errors: [result.error.error] });
      }
      return c.json({ valid: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.validate_failed');
      return apiError(c, 500, 'Failed to validate workflow');
    }
  });

  // GET /api/workflows/:name - Fetch a single workflow definition
  registerOpenApiRoute(getWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidWorkflowName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // An installed workflow (`owner/plugin:entrypoint`) has no file under a project or
      // home tree to find by name; it resolves through the catalog, by the same rule the
      // CLI and chat use for a qualified name. Any other name, including a legacy file
      // whose name contains `:`, continues to the file lookups below.
      if (name.includes(':')) {
        const { workflows } = await discoverWorkflowsWithConfig(
          workingDir ?? null,
          loadConfig,
          providerRegistry
        );
        const hit = resolveWorkflowName(
          name,
          workflows.filter(entry => entry.source === 'installed').map(entry => entry.workflow)
        );
        const entry = hit && workflows.find(candidate => candidate.workflow === hit);
        if (entry) {
          return c.json({
            workflow: Object.assign({}, entry.workflow, entry.declared),
            filename: entry.workflow.name,
            source: entry.source,
          });
        }
      }

      // 1. Try user-defined workflow in cwd.
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const projectWorkflowsRoot = join(workingDir, workflowFolder);
        try {
          const hit = await findWorkflowAt(projectWorkflowsRoot, name);
          const isSourceBundledPackage =
            hit?.packaged === true && isBundledWorkflowsRoot(projectWorkflowsRoot);
          if (hit && !isSourceBundledPackage) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              authored: authoredForm(hit.content),
              filename: hit.filename,
              source: 'project' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_failed');
          return apiError(c, 500, 'Failed to read workflow');
        }
      }

      // 2. Fall back to home-scoped workflow (`~/.archon/workflows/`).
      // Mirrors the discovery order in `discoverWorkflowsWithConfig`.
      try {
        const hit = await findWorkflowAt(getHomeWorkflowsPath(), name);
        if (hit) {
          const result = hit.parsed;
          if (result.error) {
            return apiError(c, 500, `Home workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            authored: authoredForm(hit.content),
            filename: hit.filename,
            source: 'global' as WorkflowSource,
          });
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.fetch_home_failed');
        return apiError(c, 500, 'Failed to read home-scoped workflow');
      }

      // 3. Fall back to bundled defaults.
      const bundled = findBundledWorkflow(name);
      if (bundled !== null) {
        const result = bundled.parsed;
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({
          workflow: result.workflow,
          authored: authoredForm(bundled.content),
          filename: bundled.filename,
          source: 'bundled' as WorkflowSource,
        });
      }

      if (!isBinaryBuild()) {
        try {
          const hit = await findPackagedWorkflowAt(getBundledWorkflowsPath(), name);
          if (hit) {
            const result = hit.parsed;
            if (result.error) {
              return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
            }
            return c.json({
              workflow: result.workflow,
              authored: authoredForm(hit.content),
              filename: hit.filename,
              source: 'bundled' as WorkflowSource,
            });
          }
        } catch (err) {
          getLog().error({ err, name }, 'workflow.fetch_default_failed');
          return apiError(c, 500, 'Failed to read default workflow');
        }
      }

      return apiError(c, 404, `Workflow not found: ${name}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.get_failed');
      return apiError(c, 500, 'Failed to get workflow');
    }
  });

  // PUT /api/workflows/:name - Save (create or update) a workflow
  registerOpenApiRoute(saveWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const { definition } = getValidatedBody(c, saveWorkflowBodySchema);

    try {
      const source: WorkflowSource = targetSource === 'global' ? 'global' : 'project';
      const dirPath =
        source === 'global'
          ? getHomeWorkflowsPath()
          : join(workingDir, getWorkflowFolderSearchPaths()[0]);
      const existing = await findWorkflowAt(dirPath, name);
      if (existing?.packaged === true && isBundledWorkflowsRoot(dirPath)) {
        return apiError(c, 400, `Cannot overwrite bundled default workflow: ${name}`);
      }
      const filePath = existing?.absolutePath ?? join(dirPath, `${name}.yaml`);
      const filename = existing?.filename ?? `${name}.yaml`;

      // Serialize over the file on disk so the file keeps its comments and anchors
      let yamlContent: string;
      try {
        yamlContent = serializeWorkflowPreservingText(definition, existing?.content);
      } catch (error) {
        if (error instanceof WorkflowReadBackError) {
          // A serializer defect, not bad input: writing would store a different workflow.
          getLog().error({ err: error, name }, 'workflow.save_readback_mismatch');
          return apiError(
            c,
            500,
            'Workflow was not saved: the serialized file would not match the submitted definition'
          );
        }
        const err = error instanceof Error ? error : new Error(String(error));
        getLog().error({ err, name }, 'workflow.serialize_failed');
        return apiError(c, 400, 'Failed to serialize workflow definition');
      }

      const parsed = parseWorkflow(yamlContent, `${name}.yaml`, providerRegistry);
      if (parsed.error) {
        return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
      }

      if (yamlContent !== existing?.content) {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, yamlContent, 'utf-8');
      }
      return c.json({
        workflow: parsed.workflow,
        filename,
        source,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.save_failed');
      return apiError(c, 500, 'Failed to save workflow');
    }
  });

  // DELETE /api/workflows/:name - Delete a user-defined workflow
  registerOpenApiRoute(deleteWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const targetSource = c.req.query('source');
    if (targetSource && targetSource !== 'project' && targetSource !== 'global') {
      return apiError(c, 400, 'Invalid workflow source');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (targetSource === 'global') {
      workingDir = undefined;
    } else if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const dir =
      targetSource === 'global'
        ? getHomeWorkflowsPath()
        : join(workingDir, getWorkflowFolderSearchPaths()[0]);

    try {
      const packaged = await findPackagedWorkflowAt(dir, name);
      if (packaged !== null) {
        if (isBundledWorkflowsRoot(dir)) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
        await rm(dirname(packaged.absolutePath), { recursive: true });
        return c.json({ deleted: true, name });
      }
    } catch (err) {
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }

    // Remove both `.yaml` and `.yml` variants (discovery accepts either), so a
    // twin file can't stay active after a reported deletion.
    let deleted = false;
    for (const ext of ['yaml', 'yml']) {
      const filePath = join(dir, `${name}.${ext}`);
      try {
        await unlink(filePath);
        deleted = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    if (deleted) {
      return c.json({ deleted: true, name });
    }
    if (targetSource !== 'global') {
      try {
        if (findBundledWorkflow(name) !== null) {
          return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
        }
      } catch (err) {
        getLog().error({ err, name }, 'workflow.delete_failed');
        return apiError(c, 500, 'Failed to delete workflow');
      }
    }
    return apiError(c, 404, `Workflow not found: ${name}`);
  });

  // GET /api/commands - List available command names for the workflow node palette
  registerOpenApiRoute(getCommandsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // Collect commands: precedence bundled < global < project (repo-defined wins).
      const commandMap = new Map<string, WorkflowSource>();

      // 1. Seed with bundled defaults
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        commandMap.set(name, 'bundled');
      }

      // 2. Home-scoped commands (~/.archon/commands/) override bundled
      try {
        const homeCommandsPath = getHomeCommandsPath();
        const files = await findCommandFiles(homeCommandsPath);
        for (const { commandName } of files) {
          commandMap.set(commandName, 'global');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().error({ err }, 'commands.list_home_failed');
        }
        // ENOENT: home commands dir not created yet — not an error
      }

      // 3. Project-defined commands override bundled AND global
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findCommandFiles(dirPath);
            for (const { commandName } of files) {
              commandMap.set(commandName, 'project');
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              getLog().error({ err, dirPath }, 'commands.list_project_failed');
            }
            // ENOENT: folder doesn't exist — skip
          }
        }
      }

      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });

  // GET /api/runs/:runId/artifacts - List artifact files for a run.
  // Walks the run's artifact directory and returns relative file paths with
  // size + mtime. Used by the console's Artifacts tab; the existing
  // `workflow_artifact` event stream is too sparse (bash/script nodes write
  // straight to $ARTIFACTS_DIR without emitting an event) to drive a file
  // browser on its own.
  registerOpenApiRoute(listRunArtifactsRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
      return apiError(c, 400, 'Invalid run id');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
    if (!run) return apiError(c, 404, 'Workflow run not found');

    let codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>> | null = null;
    if (run.codebase_id) {
      try {
        codebase = await codebaseDb.getCodebase(run.codebase_id);
      } catch (error) {
        getLog().error(
          { err: error, runId, codebaseId: run.codebase_id },
          'artifacts.codebase_lookup_failed'
        );
        return apiError(c, 500, 'Failed to look up codebase');
      }
    }
    // An empty 200 here is indistinguishable from "the run produced nothing",
    // so an unresolvable output location is an explicit 404 (Fail Fast).
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().warn({ runId, codebaseId: run.codebase_id }, 'artifacts.output_location_unresolved');
      return apiError(
        c,
        404,
        'Artifacts not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }

    interface FileEntry {
      path: string;
      size: number;
      modifiedAt: string;
    }
    const files: FileEntry[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        // The engine's own store is left out by the rule the CLI's listing shares;
        // a workflow's own dotfiles are its output and stay listed.
        if (isRunArtifactsEngineEntry(rel, entry.name)) continue;
        const child = join(dir, entry.name);
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(child, childRel);
        } else if (entry.isFile()) {
          try {
            const s = await stat(child);
            files.push({
              path: childRel,
              size: s.size,
              modifiedAt: s.mtime.toISOString(),
            });
          } catch (err) {
            // Race with deletion / permission flips: skip ENOENT / EACCES
            // silently, surface anything else so we don't return a half-list
            // with no diagnostic.
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EACCES') continue;
            throw err;
          }
        }
      }
    }

    try {
      await walk(artifactDir, '');
    } catch (error) {
      getLog().error({ err: error, runId, artifactDir }, 'artifacts.walk_failed');
      return apiError(c, 500, 'Failed to list artifacts');
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return c.json({ files });
  });

  // GET /api/artifacts/:runId/* - Serve workflow artifact file contents
  // The wildcard captures the filename (e.g. "plan.md", "subdir/report.md").
  // Path traversal is blocked: any segment containing ".." is rejected.
  // NOTE: Uses app.get() instead of registerOpenApiRoute because:
  //  1. Wildcard path params (*) are not representable in OpenAPI 3.0
  //  2. Response is raw text/markdown, not JSON
  app.get('/api/artifacts/:runId/*', async c => {
    const runId = c.req.param('runId');
    // Hono wildcards match but don't capture — extract filename from the URL path.
    // c.req.path is NOT percent-decoded, so we decode it manually.
    const prefix = `/api/artifacts/${runId}/`;
    const rawEncoded = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let rawFilename: string;
    try {
      rawFilename = decodeURIComponent(rawEncoded);
    } catch {
      return apiError(c, 400, 'Invalid filename');
    }

    // Block path traversal: reject if any segment is ".." or contains null bytes
    if (
      !rawFilename ||
      rawFilename.includes('\0') ||
      rawFilename.split('/').some(s => s === '..')
    ) {
      return apiError(c, 400, 'Invalid filename');
    }

    // Normalize and ensure relative (no leading slash)
    const filename = normalize(rawFilename).replace(/^[/\\]+/, '');
    if (!filename) {
      return apiError(c, 400, 'Invalid filename');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }

    if (!run) {
      return apiError(c, 404, 'Workflow run not found');
    }

    // Resolve the run's output tree for every project kind — a persisted
    // output_root first, else the shared identity→paths resolver (#2200).
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    const artifactDir = resolveRunArtifactDir(run, codebase, runId);
    if (!artifactDir) {
      getLog().error(
        { runId, codebaseId: run.codebase_id },
        'artifacts.output_location_unresolved'
      );
      return apiError(
        c,
        404,
        'Artifact not available: could not resolve this run’s output location'
      );
    }
    if (!isInsideArchonHome(artifactDir)) {
      getLog().warn(
        { runId, artifactDir, archonHome: getArchonHome() },
        'artifacts.path_escape_blocked'
      );
      return apiError(c, 400, 'Invalid artifact path');
    }
    const filePath = join(artifactDir, filename);

    // Final safety check: ensure resolved path stays within artifact directory
    if (!isPathInside(artifactDir, filePath, { includeRoot: true, lexical: true })) {
      getLog().warn({ runId, filename, filePath, artifactDir }, 'artifacts.path_escape_blocked');
      return apiError(c, 400, 'Invalid filename');
    }

    // readFile follows symlinks, so contain the resolved target within the
    // resolved artifact directory and read that checked path (#3160).
    let realArtifactDir: string;
    try {
      realArtifactDir = await realpath(artifactDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, artifactDir }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }
    let realFilePath: string;
    try {
      realFilePath = await realpath(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }
    if (!isPathInside(realArtifactDir, realFilePath, { includeRoot: true, lexical: true })) {
      getLog().warn(
        { runId, filename, realFilePath, realArtifactDir },
        'artifacts.symlink_escape_blocked'
      );
      return apiError(c, 404, 'Artifact file not found');
    }

    let content: string;
    try {
      content = await readFile(realFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }

    const contentType = filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  });

  // GET /api/config - Read-only configuration (safe subset only — no filesystem paths)
  registerOpenApiRoute(getConfigRoute, async c => {
    try {
      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_config_failed');
      return apiError(c, 500, 'Failed to get config');
    }
  });

  /**
   * A write the config validators refused is the caller's to fix: return it as a
   * 400 with the refused key. Anything else is a server fault and stays opaque.
   */
  function configUpdateFailed(
    c: Context,
    error: unknown,
    logEvent: string,
    message: string
  ): Response {
    if (error instanceof InvalidConfigError) {
      return apiError(c, 400, error.summary);
    }
    getLog().error({ err: error }, logEvent);
    return apiError(c, 500, message);
  }

  // PATCH /api/config/assistants - Update assistant configuration
  registerOpenApiRoute(patchAssistantConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAssistantConfigBodySchema);

      const updates: Partial<GlobalConfig> = {};
      if (body.assistant !== undefined) {
        if (!isRegisteredProvider(body.assistant)) {
          return apiError(c, 400, missingProviderMessage(providerRegistry, body.assistant));
        }
        updates.defaultAssistant = body.assistant;
      }
      if (body.assistants !== undefined) {
        const unknownProviders = Object.keys(body.assistants).filter(
          id => !isRegisteredProvider(id)
        );
        if (unknownProviders.length > 0) {
          return apiError(
            c,
            400,
            unknownProviders.map(id => missingProviderMessage(providerRegistry, id)).join('; ')
          );
        }
        updates.assistants = body.assistants;
      }

      await updateGlobalConfig(updates);

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.assistants_update_failed',
        'Failed to update assistant configuration'
      );
    }
  });

  // PATCH /api/config/tiers - Update model-tier presets (ungated — solo-OK, like /assistants)
  registerOpenApiRoute(patchTiersConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateTiersBodySchema);

      // Validate the provider of each tier we're SETTING (null = unset, skip).
      const tiers: TiersPatch = {};
      for (const tier of TIER_NAMES) {
        const entry = body.tiers[tier];
        if (entry === undefined) continue;
        if (entry === null) {
          tiers[tier] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`tier '${tier}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        tiers[tier] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ tiers });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.tiers_update_failed',
        'Failed to update tier configuration'
      );
    }
  });

  // PATCH /api/config/aliases - Update @custom aliases (ungated — solo-OK, like /tiers)
  registerOpenApiRoute(patchAliasesConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAliasesBodySchema);
      const aliases: AliasesPatch = {};
      for (const [name, entry] of Object.entries(body.aliases)) {
        const nameErr = validateAliasName(name);
        if (nameErr) return apiError(c, 400, nameErr);
        if (entry === null) {
          aliases[name] = null;
          continue;
        }
        const errMsg = validatePresetEntry(`alias '${name}'`, entry);
        if (errMsg) return apiError(c, 400, errMsg);
        aliases[name] = toCleanEntry(entry);
      }

      await updateGlobalConfig({ aliases });

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      return configUpdateFailed(
        c,
        error,
        'config.aliases_update_failed',
        'Failed to update alias configuration'
      );
    }
  });

  // GET /api/providers - List registered AI providers
  registerOpenApiRoute(getProvidersRoute, c => {
    return c.json({ providers: getProviderInfoList() });
  });

  // GET /api/providers/pi/models - Pi model catalog (best-effort hint; [] on failure)
  registerOpenApiRoute(getPiModelsRoute, async c => {
    try {
      const catalog = await getAgentProvider('pi').listModels?.({
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]),
      });
      const models = (catalog?.models ?? []).flatMap(model =>
        model.details
          ? [
              {
                ref: model.id,
                provider: model.details.provider,
                id: model.details.modelId,
                name: model.label ?? model.id,
                reasoning: model.details.reasoning,
                cost: model.details.cost,
                contextWindow: model.details.contextWindow,
              },
            ]
          : []
      );
      return c.json({ models });
    } catch (error) {
      // Model hints are best-effort; failure must not block the settings page.
      getLog().warn({ err: error }, 'providers.pi_models_list_failed');
      return c.json({ models: [] });
    }
  });

  // GET /api/providers/opencode/credentials - OpenCode backend introspection
  // (on-demand; starts the embedded runtime). 503 on failure — never a silent [].
  registerOpenApiRoute(getOpencodeCredentialsRoute, async c => {
    try {
      const result = await introspectOpencodeCredentials();
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'providers.opencode_credentials_introspect_failed');
      return apiError(c, 503, 'Embedded OpenCode runtime unavailable');
    }
  });

  // GET /api/codebases/:id/environments - List isolation environments for a codebase
  registerOpenApiRoute(getCodebaseEnvironmentsRoute, async c => {
    try {
      const { id } = c.req.param();
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebaseWithAge(id);
      return c.json({ environments });
    } catch (error) {
      getLog().error({ err: error }, 'codebases.environments_list_failed');
      return apiError(c, 500, 'Failed to list environments');
    }
  });

  const webPush = attention?.webPush ?? new WebPushDestination();
  registerOpenApiRoute(getWebPushKeyRoute, c => c.json({ publicKey: webPush.publicKey() }));
  registerOpenApiRoute(addWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await webPush.subscribe(web.userId, getValidatedBody(c, webPushSubscriptionSchema));
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.subscribe_failed'
      );
      return apiError(c, 500, 'Could not subscribe this browser');
    }
  });
  registerOpenApiRoute(deleteWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteWebPushSubscription(
        getValidatedBody(c, webPushDeleteSchema).endpoint,
        web.userId
      );
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.unsubscribe_failed'
      );
      return apiError(c, 500, 'Could not unsubscribe this browser');
    }
  });

  // GET /api/health - Health check with web adapter info
  registerOpenApiRoute(getHealthRoute, async c => {
    const stats = lockManager.getStats();
    const runningWorkflowRows = await workflowDb.getRunningWorkflows();

    // Merge lock-based and DB-based active tracking.
    // Background workflows bypass the lock manager, so we combine both sources.
    const lockActiveSet = new Set(stats.activeConversationIds);
    const backgroundConversationIds = runningWorkflowRows
      .map(r => r.conversation_id)
      .filter((id): id is string => id !== null && !lockActiveSet.has(id));
    const allActiveIds = [...stats.activeConversationIds, ...backgroundConversationIds];
    const wslDistro = getWSLDistroName();

    // Health is public (PUBLIC_API_GATE_PREFIXES) and must stay answerable when the
    // database is degraded, so a failed vintage read is logged and the key omitted
    // rather than turning the healthcheck into a 500. `createdAt` is deliberately not
    // exposed — the two version strings plus applied_at are what a bug report needs.
    let schema:
      | Pick<SchemaVersionInfo, 'createdAppVersion' | 'appVersion' | 'appliedAt'>
      | undefined;
    try {
      const info = await getSchemaVersion();
      if (info) {
        schema = {
          createdAppVersion: info.createdAppVersion,
          appVersion: info.appVersion,
          appliedAt: info.appliedAt,
        };
      }
    } catch (err) {
      getLog().warn({ err }, 'api.schema_version_read_failed');
    }

    const concurrency: z.infer<typeof healthConcurrencySchema> = {
      ...stats,
      active: allActiveIds.length,
      activeConversationIds: allActiveIds,
    };
    return c.json({
      status: 'ok',
      adapter: 'web',
      concurrency,
      runningWorkflows: runningWorkflowRows.length,
      version: appVersion,
      is_docker: isDocker(),
      is_wsl: isWSL(),
      ...(wslDistro ? { wsl_distro: wslDistro } : {}),
      activePlatforms: activePlatforms ? [...activePlatforms] : ['Web'],
      ...(attention ? { attentionDestinations: attention.router.health() } : {}),
      ...(schema ? { schema } : {}),
    });
  });

  registerOpenApiRoute(getUpdateCheckRoute, async c => {
    const noUpdate = {
      updateAvailable: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
      releaseUrl: '',
    };
    if (!BUNDLED_IS_BINARY) return c.json(noUpdate);
    const result = await checkForUpdate(appVersion);
    return c.json(result ?? noUpdate);
  });
}
