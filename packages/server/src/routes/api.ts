/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { rm, readFile, writeFile, unlink, mkdir, readdir, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { normalize, join, sep, basename } from 'path';
import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type {
  ConversationLockManager,
  AttachedFile,
  HandleMessageContext,
  GlobalConfig,
} from '@archon/core';
import {
  handleMessage,
  getDatabaseType,
  loadConfig,
  toSafeConfig,
  updateGlobalConfig,
  cloneRepository,
  registerRepository,
  ConversationNotFoundError,
  generateAndSetTitle,
  isPerUserGitHubEnabled,
  loadDeviceFlowConfig,
  startDeviceFlow,
  pollDeviceFlowOnce,
  persistGithubConnection,
  DeviceFlowError,
  GithubIdentityConflictError,
  getUserGithubTokenRecord,
  deleteUserGithubToken,
} from '@archon/core';
import { removeWorktree, toRepoPath, toWorktreePath } from '@archon/git';
import {
  createLogger,
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  getArchonWorkspacesPath,
  getHomeCommandsPath,
  getHomeWorkflowsPath,
  getRunArtifactsPath,
  getArchonHome,
  isDocker,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { parseWorkflow } from '@archon/workflows/loader';
import { isValidCommandName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { MessageRow } from '@archon/core/schemas/message';
import type { DashboardWorkflowRun } from '@archon/core/schemas/workflow-run';
import { findMarkdownFilesRecursive } from '@archon/core/utils/commands';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api');
  return cachedLog;
}
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as messageDb from '@archon/core/db/messages';
import * as userDb from '@archon/core/db/users';
import { resetWorkflowNodeSessions } from '@archon/core/operations/workflow-operations';
import { errorSchema } from './schemas/common.schemas';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import {
  workflowListResponseSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  getWorkflowResponseSchema,
  saveWorkflowBodySchema,
  deleteWorkflowResponseSchema,
  commandListResponseSchema,
  workflowRunListResponseSchema,
  workflowRunDetailSchema,
  workflowRunByWorkerResponseSchema,
  cancelWorkflowRunResponseSchema,
  workflowRunActionResponseSchema,
  dashboardRunsResponseSchema,
  dashboardRunsQuerySchema,
  workflowRunsQuerySchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
  resetWorkflowNodeSessionsParamsSchema,
  resetWorkflowNodeSessionsQuerySchema,
  resetWorkflowNodeSessionsResponseSchema,
  listArtifactsResponseSchema,
} from './schemas/workflow.schemas';
import {
  conversationListResponseSchema,
  listConversationsQuerySchema,
  conversationIdParamsSchema,
  conversationSchema,
  createConversationBodySchema,
  createConversationResponseSchema,
  updateConversationBodySchema,
  successResponseSchema,
  messageListResponseSchema,
  listMessagesQuerySchema,
  dispatchResponseSchema,
} from './schemas/conversation.schemas';
import {
  codebaseListResponseSchema,
  codebaseSchema,
  codebaseIdParamsSchema,
  addCodebaseBodySchema,
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
  codebaseEnvironmentsResponseSchema,
} from './schemas/config.schemas';
import { providerListResponseSchema } from './schemas/provider.schemas';
import {
  deviceStartResponseSchema,
  devicePollBodySchema,
  devicePollResponseSchema,
  githubConnectionStatusSchema,
  githubDisconnectResponseSchema,
} from './schemas/auth.schemas';
import { mapDeviceFlowErrorToPollStatus } from './auth-poll-status';
import { getProviderInfoList, isRegisteredProvider } from '@archon/providers';
import { messageSchema } from './schemas/conversation.schemas';
import {
  workflowRunSchema,
  dashboardWorkflowRunSchema,
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

type WorkflowSource = 'project' | 'bundled' | 'global';

// =========================================================================
// OpenAPI route configs (module-scope — pure config, no runtime dependencies)
// =========================================================================

/** Helper to build a JSON error response entry for createRoute configs. */
function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
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
// Conversation route configs
// =========================================================================

const getConversationsRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'List conversations',
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Get a conversation by platform conversation ID',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationSchema } },
      description: 'Conversation',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'Create a new conversation',
  request: {
    body: {
      content: { 'application/json': { schema: createConversationBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Created conversation',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Update a conversation (title)',
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Updated',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Soft-delete a conversation',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/messages',
  tags: ['Conversations'],
  summary: 'List message history for a conversation',
  request: {
    params: conversationIdParamsSchema,
    query: listMessagesQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: messageListResponseSchema } },
      description: 'Message list',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// Body validation is handled manually in the handler (multipart vs JSON branching).
// Declaring both content types in the OpenAPI route causes @hono/zod-openapi to
// validate JSON bodies against the multipart schema. We keep `request.body` empty
// and document the schemas via the OpenAPI spec comments instead.
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/message',
  tags: ['Conversations'],
  summary: 'Send a message (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ message: string }` or `multipart/form-data` ' +
    'with a `message` field and optional file attachments (max 5 files, 10 MB each).',
  request: {
    params: conversationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
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
    'Accepts `application/json` with `{ conversationId, message }` or ' +
    '`multipart/form-data` with `conversationId`, `message`, and optional file ' +
    'attachments (max 5 files, 10 MB each).',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const listRunArtifactsRoute = createRoute({
  method: 'get',
  path: '/api/runs/{runId}/artifacts',
  tags: ['Workflows'],
  summary: "List a run's artifact files",
  description:
    "Walks the run's artifact directory and returns relative file paths with size + " +
    'mtime. Drives the console Artifacts tab. Returns `{ files: [] }` when the run ' +
    'has no codebase or the codebase name is not in `owner/repo` form.',
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
    404: jsonError('Not found'),
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
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const abandonWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/abandon',
  tags: ['Workflows'],
  summary: 'Abandon a workflow run (mark as failed)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Abandoned',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
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
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
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
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
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
    500: jsonError('Server error'),
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
    400: jsonError('Invalid request body'),
    500: jsonError('Server error'),
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

const githubDeviceStartRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/start',
  tags: ['Auth'],
  summary: 'Start the GitHub device flow for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: deviceStartResponseSchema } },
      description: 'Device + user codes',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubDevicePollRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/poll',
  tags: ['Auth'],
  summary: 'Poll the GitHub device flow once for the current web user',
  request: {
    body: { content: { 'application/json': { schema: devicePollBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: devicePollResponseSchema } },
      description: 'Poll status',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubConnectionStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'GitHub connection status for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: githubConnectionStatusSchema } },
      description: 'Connection status',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
  },
});

const githubDisconnectRoute = createRoute({
  method: 'delete',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'Disconnect the current web user’s GitHub identity',
  responses: {
    200: {
      content: { 'application/json': { schema: githubDisconnectResponseSchema } },
      description: 'Disconnected',
    },
    401: jsonError('Web auth required (X-Archon-User header missing)'),
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
              concurrency: z.record(z.string(), z.unknown()),
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              activePlatforms: z.array(z.string()).optional(),
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
  activePlatforms?: readonly string[]
): void {
  function apiError(
    c: Context,
    status: 400 | 401 | 404 | 422 | 500 | 503,
    message: string,
    detail?: string
  ): Response {
    return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
  }

  /**
   * Validate that a caller-supplied `cwd` is rooted at a registered codebase path.
   * This prevents path traversal — callers cannot read/write outside known project roots.
   */
  async function validateCwd(cwd: string): Promise<boolean> {
    const codebases = await codebaseDb.listCodebases();
    const normalizedCwd = normalize(cwd);
    return codebases.some(cb => {
      const base = normalize(cb.default_cwd);
      return normalizedCwd === base || normalizedCwd.startsWith(base + sep);
    });
  }

  // CORS for Web UI — allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  /**
   * Resolve the current web user from the trusted reverse-proxy header
   * (ARCHON_WEB_AUTH_HEADER, default `X-Archon-User`). The proxy authenticates
   * (e.g. Caddy basicauth) and sets the header; Archon trusts it. Absent header
   * → undefined (NULL attribution, never elevated). The opaque username is
   * resolved to a stable Archon user via the 'web' platform identity.
   *
   * SECURITY: this is only safe when Archon is reachable solely through the
   * reverse proxy (bind 127.0.0.1). The server logs a startup warning otherwise.
   */
  async function resolveWebUserId(c: Context): Promise<string | undefined> {
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const headerVal = c.req.header(headerName)?.trim();
    if (!headerVal) return undefined;
    try {
      const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
      return user.id;
    } catch (err) {
      // Best-effort attribution: the header WAS present, but identity resolution
      // failed (e.g. DB outage). Fall back to NULL attribution rather than
      // failing the request. headerPresent distinguishes this from "no header".
      getLog().warn({ err: err as Error, headerPresent: true }, 'web.user_resolve_failed');
      return undefined;
    }
  }

  /**
   * Strict variant for endpoints that REQUIRE a web identity (connect/disconnect).
   * Unlike resolveWebUserId, this distinguishes a missing header (401) from a
   * backend failure resolving the header to a user (503) — a DB outage must not
   * masquerade as "authentication required". Returns the resolved id, or the
   * HTTP error Response the caller should return verbatim.
   */
  async function requireWebUser(
    c: Context,
    failMessage = 'Web authentication required'
  ): Promise<{ userId: string } | { error: Response }> {
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const headerVal = c.req.header(headerName)?.trim();
    if (!headerVal) return { error: apiError(c, 401, failMessage) };
    try {
      const user = await userDb.findOrCreateUserByPlatformIdentity('web', headerVal, headerVal);
      return { userId: user.id };
    } catch (err) {
      getLog().error({ err: err as Error, headerPresent: true }, 'web.user_resolve_failed');
      return { error: apiError(c, 503, 'Could not verify web identity — backend unavailable') };
    }
  }

  // ---- GitHub device-flow connect endpoints ----
  registerOpenApiRoute(githubDeviceStartRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    try {
      const { clientId } = loadDeviceFlowConfig();
      const device = await startDeviceFlow(clientId);
      return c.json({
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        interval: device.interval,
        expires_in: device.expires_in,
      });
    } catch (err) {
      getLog().error({ err: err as Error }, 'auth.github_device_start_failed');
      return apiError(c, 500, 'Failed to start GitHub device flow');
    }
  });

  registerOpenApiRoute(githubDevicePollRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    const { device_code: deviceCode } = getValidatedBody(c, devicePollBodySchema);
    try {
      const { clientId } = loadDeviceFlowConfig();
      const result = await pollDeviceFlowOnce(clientId, deviceCode);
      if (result.status === 'pending' || result.status === 'slow_down') {
        return c.json({ status: 'pending' as const });
      }
      if (result.status === 'error') {
        // Terminal device-flow codes → client-visible status (testable helper).
        return c.json({ status: mapDeviceFlowErrorToPollStatus(result.code), detail: result.code });
      }
      // authorized
      const { githubLogin } = await persistGithubConnection(web.userId, result.token);
      return c.json({ status: 'connected' as const, githubLogin });
    } catch (err) {
      if (err instanceof GithubIdentityConflictError) {
        return c.json({ status: 'error' as const, detail: err.message });
      }
      if (err instanceof DeviceFlowError) {
        return c.json({ status: 'error' as const, detail: err.code });
      }
      getLog().error({ err: err as Error }, 'auth.github_device_poll_failed');
      return apiError(c, 500, 'Failed to poll GitHub device flow');
    }
  });

  registerOpenApiRoute(githubConnectionStatusRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const record = await getUserGithubTokenRecord(web.userId);
      return c.json({ connected: record !== null, githubLogin: record?.github_login ?? null });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_status_failed');
      return apiError(c, 500, 'Failed to read GitHub connection status');
    }
  });

  registerOpenApiRoute(githubDisconnectRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteUserGithubToken(web.userId);
      return c.json({ success: true });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_disconnect_failed');
      return apiError(c, 500, 'Failed to disconnect GitHub');
    }
  });

  // Shared lock/dispatch/error handling for message and workflow endpoints
  /** Maximum allowed upload size per file (10 MB) */
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  /** Maximum number of files per message (enforced server-side) */
  const MAX_FILES_PER_MESSAGE = 5;
  /**
   * Binary (non-text) MIME types explicitly allowed for upload.
   * All text/* types are accepted separately via isAllowedUploadType().
   */
  const ALLOWED_UPLOAD_BINARY_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    // application/json is a structured text type browsers may report for .json files
    'application/json',
  ]);

  /** Extensions accepted when browser reports an empty MIME type (code/config files). */
  const ALLOWED_UPLOAD_EXTENSIONS = new Set([
    '.md',
    '.txt',
    '.csv',
    '.xml',
    '.html',
    '.htm',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.env',
    '.log',
    '.css',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.java',
    '.c',
    '.cpp',
    '.cc',
    '.cxx',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.rs',
    '.swift',
    '.kt',
    '.scala',
    '.r',
    '.sql',
  ]);

  /** Returns true if the MIME type is allowed for upload. */
  function isAllowedUploadType(mimeType: string, fileName: string): boolean {
    // All text/* types are acceptable (covers .md, .py, .rs, .go, .sh, .yaml, etc.)
    if (mimeType.startsWith('text/')) return true;
    if (ALLOWED_UPLOAD_BINARY_MIME_TYPES.has(mimeType)) return true;
    // Browsers assign empty MIME types to many code/config extensions — fall back to extension
    if (!mimeType) {
      const dotIndex = fileName.lastIndexOf('.');
      if (dotIndex !== -1) {
        return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
      }
    }
    return false;
  }

  /**
   * Persist multipart-uploaded files to the conversation's upload directory.
   * Called from /api/workflows/:name/run; /api/conversations/:id/message still
   * inlines the same validate-write-rollback logic and could migrate to this
   * helper as a separate hygiene pass.
   *
   * Returns either { ok: true, savedFiles, uploadDir } or a structured error
   * the caller forwards via apiError; on the success path the caller passes
   * savedFiles + uploadDir to dispatchToOrchestrator so cleanup happens
   * inside the lock handler.
   */
  async function persistUploadedFiles(
    conversationId: string,
    fileEntries: File[]
  ): Promise<
    | { ok: true; savedFiles: AttachedFile[]; uploadDir: string }
    | { ok: false; status: 400 | 500; error: string }
  > {
    if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
      return {
        ok: false,
        status: 400,
        error: `Maximum ${MAX_FILES_PER_MESSAGE.toString()} files per message`,
      };
    }

    const archonHome = getArchonHome();
    const uploadDir = join(archonHome, 'artifacts', 'uploads', conversationId);
    if (!uploadDir.startsWith(archonHome + sep)) {
      return { ok: false, status: 400, error: 'Invalid conversation ID' };
    }

    // Validate all files before writing any to disk.
    for (const entry of fileEntries) {
      const displayName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!isAllowedUploadType(entry.type, entry.name)) {
        return {
          ok: false,
          status: 400,
          error: `File "${displayName}" has an unsupported type: ${entry.type}`,
        };
      }
      if (entry.size > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          status: 400,
          error: `File "${displayName}" exceeds the 10 MB size limit`,
        };
      }
    }

    const savedFiles: AttachedFile[] = [];
    try {
      await mkdir(uploadDir, { recursive: true });
      for (const entry of fileEntries) {
        const fileId = randomUUID();
        const safeName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = join(uploadDir, `${fileId}_${safeName}`);
        await writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
        const normalizedMime =
          entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
        savedFiles.push({
          path: filePath,
          name: safeName || fileId,
          mimeType: normalizedMime,
          size: entry.size,
        });
      }
    } catch (writeErr: unknown) {
      for (const f of savedFiles) {
        await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') {
            getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
          }
        });
      }
      getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
      return {
        ok: false,
        status: 500,
        error: 'Failed to save uploaded file. Check available disk space.',
      };
    }

    return { ok: true, savedFiles, uploadDir };
  }

  async function dispatchToOrchestrator(
    conversationId: string,
    message: string,
    extraContext?: Omit<HandleMessageContext, 'isolationHints'>,
    filesToCleanup?: { files: AttachedFile[]; uploadDir: string }
  ): Promise<{ accepted: boolean; status: string }> {
    const result = await lockManager.acquireLock(conversationId, async () => {
      // Emit lock:true at handler start so the UI knows processing has begun.
      // Fire-and-forget — if no SSE stream is connected yet, the event is buffered.
      webAdapter.emitLockEvent(conversationId, true);
      try {
        await handleMessage(webAdapter, conversationId, message, {
          isolationHints: { workflowType: 'thread', workflowId: conversationId },
          ...extraContext,
        });
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        await webAdapter.emitLockEvent(conversationId, false);
        // Clean up uploaded files AFTER handleMessage completes so the AI subprocess
        // has had a chance to read them. Doing this in the HTTP handler's finally block
        // would delete files while the fire-and-forget lock handler is still running.
        if (filesToCleanup) {
          for (const f of filesToCleanup.files) {
            await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn({ err, filePath: f.path, conversationId }, 'upload.cleanup_failed');
              }
            });
          }
          // Remove the now-empty upload directory for this conversation.
          await rm(filesToCleanup.uploadDir, { recursive: true, force: true }).catch(
            (err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn(
                  { err, uploadDir: filesToCleanup.uploadDir, conversationId },
                  'upload.dir_cleanup_failed'
                );
              }
            }
          );
        }
      }
    });

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      // Intentionally fire-and-forget: the lock-acquire signal (locked: true) is sent
      // optimistically so the UI shows a queued state immediately. It is not awaited
      // because we want the HTTP response to return before the SSE write completes.
      // The lock-release signal (locked: false) IS awaited inside the task callback
      // above to guarantee ordering — all tool results and flush must precede the
      // release event on the SSE stream.
      webAdapter.emitLockEvent(conversationId, true);
    }

    return { accepted: true, status: result.status };
  }

  /**
   * Re-enter the orchestrator after a paused approval gate is resolved, so a
   * web-dispatched workflow continues (approve) or runs its on_reject prompt
   * (reject) without the user having to re-run the workflow command. The CLI's
   * `workflowApproveCommand` / `workflowRejectCommand` already auto-resume via
   * `workflowRunCommand({ resume: true })`; this is the web-side equivalent.
   *
   * Returns `true` when a resume dispatch was initiated, `false` otherwise (no
   * parent conversation on the run, parent conversation deleted, parent was on
   * a non-web platform, or dispatch threw). Failures are non-fatal: the gate
   * decision is recorded regardless; when this returns `false` the response
   * text instructs the user to re-run the workflow command.
   *
   * **Cross-adapter guard**: only web-sourced parents qualify.
   * `dispatchToOrchestrator` is wired to the web adapter + its lock manager,
   * so a Slack / Telegram / GitHub / Discord run being approved from the
   * dashboard must not route through it — the Slack thread would never see
   * the resumed output. Non-web parents skip auto-resume and the originating
   * platform's own re-run flow applies.
   */
  async function tryAutoResumeAfterGate(
    run: WorkflowRun,
    action: 'approve' | 'reject'
  ): Promise<boolean> {
    if (!run.parent_conversation_id) return false;
    // Literal event names per action — greppable for ops tooling. Keeping the
    // branch explicit rather than templating avoids the earlier 3-segment
    // `api.workflow_*.dispatched` shape that broke `{domain}.{action}_{state}`.
    const events =
      action === 'approve'
        ? {
            dispatched: 'api.workflow_approve_auto_resume_dispatched' as const,
            skippedNoPlatformConv:
              'api.workflow_approve_auto_resume_skipped_no_platform_conv' as const,
            skippedNonWebParent: 'api.workflow_approve_auto_resume_skipped_non_web_parent' as const,
            failed: 'api.workflow_approve_auto_resume_failed' as const,
          }
        : {
            dispatched: 'api.workflow_reject_auto_resume_dispatched' as const,
            skippedNoPlatformConv:
              'api.workflow_reject_auto_resume_skipped_no_platform_conv' as const,
            skippedNonWebParent: 'api.workflow_reject_auto_resume_skipped_non_web_parent' as const,
            failed: 'api.workflow_reject_auto_resume_failed' as const,
          };
    try {
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      const platformConvId = parentConv?.platform_conversation_id;
      if (!platformConvId) {
        // parentConv === null is a data-integrity signal (the parent
        // conversation was deleted while the run was paused) — worth
        // surfacing at info level so operators notice. Missing
        // platform_conversation_id on an existing row shouldn't happen and
        // stays at debug.
        const logFn =
          parentConv === null ? getLog().info.bind(getLog()) : getLog().debug.bind(getLog());
        logFn(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            parentDeleted: parentConv === null,
          },
          events.skippedNoPlatformConv
        );
        return false;
      }
      if (parentConv.platform_type !== 'web') {
        getLog().debug(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            platformType: parentConv.platform_type,
          },
          events.skippedNonWebParent
        );
        return false;
      }
      const resumeMessage = `/workflow run ${run.workflow_name} ${run.user_message ?? ''}`.trim();
      await dispatchToOrchestrator(platformConvId, resumeMessage);
      getLog().info(
        { runId: run.id, workflowName: run.workflow_name, platformConvId },
        events.dispatched
      );
      return true;
    } catch (err) {
      getLog().warn({ err: err as Error, runId: run.id }, events.failed);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // API transform helpers (Date → ISO string for wire shape)
  // ---------------------------------------------------------------------------

  type ApiConversation = z.infer<typeof conversationSchema>;
  type ApiCodebase = z.infer<typeof codebaseSchema>;
  type ApiMessage = z.infer<typeof messageSchema>;
  type ApiWorkflowRun = z.infer<typeof workflowRunSchema>;
  type ApiDashboardWorkflowRun = z.infer<typeof dashboardWorkflowRunSchema>;

  function toISOString(val: Date | string): string;
  function toISOString(val: Date | string | null | undefined): string | null;
  function toISOString(val: Date | string | null | undefined): string | null {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') return val;
    try {
      return val.toISOString();
    } catch (e) {
      getLog().error({ err: e as Error, invalidDate: val }, 'api.invalid_date_transform');
      return null;
    }
  }

  function toApiConversation(row: import('@archon/core').Conversation): ApiConversation {
    return {
      ...row,
      created_at: toISOString(row.created_at),
      updated_at: toISOString(row.updated_at),
      deleted_at: toISOString(row.deleted_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  function toApiCodebase(row: import('@archon/core').Codebase): ApiCodebase {
    let commands = row.commands;
    if (typeof commands === 'string') {
      try {
        commands = JSON.parse(commands) as Record<string, { path: string; description: string }>;
      } catch (parseErr) {
        getLog().error({ err: parseErr as Error, codebaseId: row.id }, 'corrupted_commands_json');
        // Fallback: empty map keeps the API response valid and prevents the endpoint
        // from crashing. The corruption is already logged above for operator attention.
        commands = {};
      }
    }
    return {
      ...row,
      commands,
      created_at: toISOString(row.created_at),
      updated_at: toISOString(row.updated_at),
    };
  }

  function toApiMessage(row: MessageRow): ApiMessage {
    let metadata = row.metadata;
    if (typeof metadata !== 'string') {
      try {
        metadata = JSON.stringify(metadata);
      } catch (e) {
        getLog().error(
          { err: e as Error, messageId: row.id },
          'api.message_metadata_serialize_failed'
        );
        metadata = '{}';
      }
    }
    return { ...row, metadata };
  }

  function toApiWorkflowRun(row: WorkflowRun): ApiWorkflowRun {
    return {
      ...row,
      started_at: toISOString(row.started_at),
      completed_at: toISOString(row.completed_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  function toApiDashboardWorkflowRun(row: DashboardWorkflowRun): ApiDashboardWorkflowRun {
    return {
      ...row,
      started_at: toISOString(row.started_at),
      completed_at: toISOString(row.completed_at),
      last_activity_at: toISOString(row.last_activity_at),
    };
  }

  // GET /api/conversations - List conversations
  registerOpenApiRoute(getConversationsRoute, async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const conversations = await conversationDb.listConversations(
        50,
        platformType,
        codebaseId,
        true
      );
      return c.json(conversations.map(toApiConversation));
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return apiError(c, 500, 'Failed to list conversations');
    }
  });

  // GET /api/conversations/:id - Get single conversation by platform conversation ID
  registerOpenApiRoute(getConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      return c.json(toApiConversation(conv));
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_failed');
      return apiError(c, 500, 'Failed to get conversation');
    }
  });

  // POST /api/conversations - Create new conversation
  // Accepts optional `message` field for atomic create+send (avoids ghost "Untitled" entries)
  registerOpenApiRoute(createConversationRoute, async c => {
    try {
      const { codebaseId, message } = getValidatedBody(c, createConversationBodySchema);
      const userId = await resolveWebUserId(c);

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId,
        undefined,
        userId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          await messageDb.addMessage(conversation.id, 'user', message, undefined, userId);
        } catch (e: unknown) {
          // Log only (no SSE warning) — the SSE stream isn't connected yet for new conversations.
          // The existing /message endpoint emits a warning because the stream is guaranteed to be active.
          getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
        }

        // Set placeholder title immediately so the sidebar never shows "Untitled conversation"
        const placeholderTitle = message.length > 60 ? message.slice(0, 60) + '...' : message;
        await conversationDb.updateConversationTitle(conversation.id, placeholderTitle);

        // Generate proper AI title for non-command messages (fire-and-forget, overwrites placeholder)
        if (!message.startsWith('/')) {
          void generateAndSetTitle(
            conversation.id,
            message,
            conversation.ai_assistant_type,
            getArchonWorkspacesPath()
          );
        }

        const result = await dispatchToOrchestrator(
          conversation.platform_conversation_id,
          message,
          { userId }
        );

        return c.json({
          conversationId: conversation.platform_conversation_id,
          id: conversation.id,
          dispatched: true,
          ...result,
        });
      }

      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title)
  registerOpenApiRoute(updateConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { title } = getValidatedBody(c, updateConversationBodySchema);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      if (title !== undefined) {
        await conversationDb.updateConversationTitle(conv.id, title.slice(0, 255));
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  registerOpenApiRoute(deleteConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      await conversationDb.softDeleteConversation(conv.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // GET /api/conversations/:id/messages - Message history
  registerOpenApiRoute(listMessagesRoute, async c => {
    const platformConversationId = c.req.param('id') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformConversationId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      const messages = await messageDb.listMessages(conv.id, limit);
      return c.json(messages.map(toApiMessage));
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return apiError(c, 500, 'Failed to list messages');
    }
  });

  // POST /api/conversations/:id/message - Send message
  // Manual body parsing: multipart uses parseBody(), JSON uses req.json().
  registerOpenApiRoute(sendMessageRoute, async c => {
    const conversationId = c.req.param('id') ?? '';
    const userId = await resolveWebUserId(c);

    // Reject conversation IDs that could be used for path traversal when building
    // the upload directory. Web conversation IDs are alphanumeric with hyphens only.
    if (!/^[\w-]+$/.test(conversationId)) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    let message: string;
    let savedFiles: AttachedFile[] = [];
    let uploadDir = '';

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'upload.parse_failed');
        return c.json({ error: 'Invalid multipart form data' }, 400);
      }

      const rawMessage = body.message;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = rawMessage;

      const rawFiles = body.files;
      let fileList: (string | File)[];
      if (Array.isArray(rawFiles)) {
        fileList = rawFiles;
      } else if (rawFiles !== undefined) {
        fileList = [rawFiles];
      } else {
        fileList = [];
      }

      const fileEntries = fileList.filter((e): e is File => e instanceof File);
      if (fileEntries.length > 0) {
        const result = await persistUploadedFiles(conversationId, fileEntries);
        if (!result.ok) {
          return c.json({ error: result.error }, result.status);
        }
        savedFiles = result.savedFiles;
        uploadDir = result.uploadDir;
        getLog().info({ conversationId, fileCount: savedFiles.length }, 'message.files_uploaded');
      }
    } else {
      let body: { message?: unknown };
      try {
        body = await c.req.json();
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'message.json_parse_failed');
        return c.json({ error: 'Invalid JSON in request body' }, 400);
      }

      if (typeof body.message !== 'string' || !body.message) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = body.message;
    }

    // Look up conversation for message persistence
    let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
    try {
      conv = await conversationDb.findConversationByPlatformId(conversationId);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
    }

    // Persist user message and pass DB ID to adapter for assistant message persistence
    if (conv) {
      // Omit path from persisted metadata — the on-disk file is ephemeral and will be
      // deleted after the AI processes it; storing stale paths would confuse future readers.
      const meta =
        savedFiles.length > 0
          ? { files: savedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size })) }
          : undefined;
      try {
        await messageDb.addMessage(conv.id, 'user', message, meta, userId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'warning',
              message: 'Message could not be saved to history',
              timestamp: Date.now(),
            })
          );
        } catch (sseErr: unknown) {
          getLog().error({ err: sseErr, conversationId: conv?.id }, 'sse_warning_double_failure');
        }
      }
      webAdapter.setConversationDbId(conversationId, conv.id);
    }

    // Pass savedFiles to dispatchToOrchestrator so cleanup happens inside the lock handler,
    // AFTER handleMessage completes — not in the HTTP handler's finally block where the
    // fire-and-forget lock callback may still be running and the AI has not yet read the files.
    const extraContext: Omit<HandleMessageContext, 'isolationHints'> =
      savedFiles.length > 0 ? { userId, attachedFiles: savedFiles } : { userId };
    let filesToCleanup: { files: AttachedFile[]; uploadDir: string } | undefined;
    if (savedFiles.length > 0) {
      filesToCleanup = { files: savedFiles, uploadDir };
    }
    const result = await dispatchToOrchestrator(
      conversationId,
      message,
      extraContext,
      filesToCleanup
    );
    return c.json(result);
  });

  // GET /api/stream/__dashboard__ — multiplexed dashboard SSE (all workflow events)
  // IMPORTANT: Must be registered before /api/stream/:conversationId to avoid param capture.
  app.get('/api/stream/__dashboard__', async c => {
    return streamSSE(c, async stream => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream('__dashboard__', stream);
      getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_opened');

      stream.onAbort(() => {
        getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_disconnected');
        webAdapter.removeStream('__dashboard__', stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error }, 'dashboard_sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream('__dashboard__', stream);
        getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_closed');
      }
    });
  });

  // GET /api/stream/:conversationId - SSE streaming
  app.get('/api/stream/:conversationId', async c => {
    const conversationId = c.req.param('conversationId');

    return streamSSE(c, async stream => {
      // Send initial heartbeat immediately to flush HTTP headers.
      // Without this, EventSource stays in CONNECTING state until the first write.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(conversationId, stream);
      getLog().debug({ conversationId }, 'sse_stream_opened');

      stream.onAbort(() => {
        getLog().debug({ conversationId }, 'sse_client_disconnected');
        webAdapter.removeStream(conversationId, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        // stream.sleep() throws when client disconnects — expected behavior.
        // Log unexpected errors for debugging.
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error, conversationId }, 'sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(conversationId, stream);
        getLog().debug({ conversationId }, 'sse_stream_closed');
      }
    });
  });

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

  // POST /api/codebases - Add a project (clone from URL or register local path)
  registerOpenApiRoute(addCodebaseRoute, async c => {
    const body = getValidatedBody(c, addCodebaseBodySchema);

    try {
      // .refine() guarantees exactly one of url/path is present
      const result = body.url
        ? await cloneRepository(body.url)
        : await registerRepository(body.path ?? '');

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return apiError(c, 500, 'Codebase created but not found');
      }

      return c.json(toApiCodebase(codebase), result.alreadyExisted ? 200 : 201);
    } catch (error) {
      getLog().error({ err: error }, 'add_codebase_failed');
      return apiError(
        c,
        500,
        `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}`
      );
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

      // Clean up isolation environments (worktrees)
      const environments = await isolationEnvDb.listByCodebase(id);
      for (const env of environments) {
        try {
          await removeWorktree(toRepoPath(codebase.default_cwd), toWorktreePath(env.working_path));
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          // Worktree may already be gone — log but continue
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
        }
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      }

      // Delete from database (unlinks conversations and sessions)
      await codebaseDb.deleteCodebase(id);

      // Remove workspace directory from disk — only for Archon-managed repos
      const workspacesRoot = normalize(getArchonWorkspacesPath());
      const normalizedCwd = normalize(codebase.default_cwd);
      if (
        normalizedCwd.startsWith(workspacesRoot + '/') ||
        normalizedCwd.startsWith(workspacesRoot + '\\')
      ) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          // Directory may not exist — log but don't fail
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
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

  /**
   * Register a route with OpenAPI spec generation and input validation.
   * Zod validates inputs (query, params, body) at runtime via defaultHook.
   * Response schemas are used for OpenAPI spec generation only — output is not
   * validated at runtime. The `as never` cast bypasses TypedResponse constraints.
   */
  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  /** Access Zod-validated body from a handler registered via registerOpenApiRoute. */
  function getValidatedBody<T>(c: Context, _schema: z.ZodType<T>): T {
    return (c.req as unknown as { valid(k: 'json'): T }).valid('json');
  }

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
      const result = await discoverWorkflowsWithConfig(workingDir ?? null, loadConfig);
      return c.json({
        workflows: result.workflows.map(ws => ({ workflow: ws.workflow, source: ws.source })),
        errors: result.errors.length > 0 ? result.errors : undefined,
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
  //   - application/json: { conversationId, message }
  //   - multipart/form-data: conversationId + message + files[] (≤5, ≤10MB each)
  //
  // Multipart matches /api/conversations/:id/message so the console's draft
  // run input can attach screenshots / stack traces / paste-blobs the same
  // way a freeform chat message can.
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    const userId = await resolveWebUserId(c);
    if (!isValidCommandName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    let message: string;
    let conversationId: string;
    let savedFiles: AttachedFile[] = [];
    let uploadDir = '';

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

      const rawFiles = body.files;
      const fileList: (string | File)[] = Array.isArray(rawFiles)
        ? rawFiles
        : rawFiles !== undefined
          ? [rawFiles]
          : [];
      const fileEntries = fileList.filter((e): e is File => e instanceof File);

      if (fileEntries.length > 0) {
        const result = await persistUploadedFiles(conversationId, fileEntries);
        if (!result.ok) {
          return apiError(c, result.status, result.error);
        }
        savedFiles = result.savedFiles;
        uploadDir = result.uploadDir;
        getLog().info(
          { conversationId, fileCount: savedFiles.length, workflowName },
          'run_workflow.files_uploaded'
        );
      }
    } else {
      let body: { conversationId?: unknown; message?: unknown };
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
      conversationId = body.conversationId;
      message = body.message;
    }

    try {
      // Persist user message and register DB ID (same as message endpoint).
      // File metadata (name/mime/size — no path, since the on-disk file is
      // ephemeral) goes into message metadata when present.
      let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
      try {
        conv = await conversationDb.findConversationByPlatformId(conversationId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
      }
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
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        if (!conv.title) {
          void generateAndSetTitle(
            conv.id,
            message,
            conv.ai_assistant_type,
            getArchonWorkspacesPath(),
            workflowName
          );
        }
      }

      const fullMessage = `/workflow run ${workflowName} ${message}`;
      const extraContext: Omit<HandleMessageContext, 'isolationHints'> =
        savedFiles.length > 0 ? { userId, attachedFiles: savedFiles } : { userId };
      const filesToCleanup = savedFiles.length > 0 ? { files: savedFiles, uploadDir } : undefined;
      const result = await dispatchToOrchestrator(
        conversationId,
        fullMessage,
        extraContext,
        filesToCleanup
      );
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return apiError(c, 500, 'Failed to run workflow');
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

  // POST /api/workflows/runs/:runId/cancel - Cancel a workflow run
  registerOpenApiRoute(cancelWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status !== 'running' && run.status !== 'pending' && run.status !== 'paused') {
        return apiError(c, 400, `Cannot cancel workflow in '${run.status}' status`);
      }
      const { cancelled } = await workflowDb.cancelWorkflowRun(runId);
      return c.json({
        success: true,
        message: cancelled
          ? `Cancelled workflow: ${run.workflow_name}`
          : `Workflow ${run.workflow_name} already finished — nothing to cancel.`,
      });
    } catch (error) {
      getLog().error({ err: error }, 'cancel_workflow_run_api_failed');
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
      if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot resume workflow in '${run.status}' status`);
      }
      // Dispatch resume by sending `/workflow run <name>` to the parent web
      // conversation; the orchestrator's foreground-resume detection (via
      // findResumableRunByParentConversation) picks up the failed run and
      // hydrates it. Mirrors the approve/reject auto-resume path.
      if (!run.parent_conversation_id) {
        return apiError(
          c,
          400,
          `This run was created outside the web UI. Use \`archon workflow resume ${runId}\` from the CLI to resume it.`
        );
      }
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      if (!parentConv?.platform_conversation_id || parentConv.platform_type !== 'web') {
        return apiError(
          c,
          400,
          `Cannot resume from web UI: the run's parent conversation is not a web conversation. Use \`archon workflow resume ${runId}\` from the CLI.`
        );
      }
      const resumeMessage = `/workflow run ${run.workflow_name} ${run.user_message ?? ''}`.trim();
      await dispatchToOrchestrator(parentConv.platform_conversation_id, resumeMessage);
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
      getLog().error({ err: error, runId }, 'api.workflow_run_resume_failed');
      return apiError(c, 500, 'Failed to resume workflow run');
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
      if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot abandon workflow in '${run.status}' status`);
      }
      await workflowDb.cancelWorkflowRun(runId);
      return c.json({ success: true, message: `Abandoned workflow: ${run.workflow_name}` });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_abandon_failed');
      return apiError(c, 500, 'Failed to abandon workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/approve - Approve a paused workflow run
  registerOpenApiRoute(approveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot approve workflow in '${run.status}' status`);
      }
      const body = (await c.req.json().catch(() => ({}))) as { comment?: string };
      const comment = body.comment ?? 'Approved';
      const approval = run.metadata.approval as ApprovalContext | undefined;
      if (!approval?.nodeId) {
        return apiError(c, 400, 'Workflow run is paused but missing approval context');
      }
      // For interactive loops, do NOT write node_completed — the executor writes it when
      // the AI emits the completion signal (actual loop exit). Writing it here would cause
      // the resume to skip the loop node entirely via priorCompletedNodes.
      if (approval.type !== 'interactive_loop') {
        const nodeOutput = approval.captureResponse === true ? comment : '';
        await workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'node_completed',
          step_name: approval.nodeId,
          data: { node_output: nodeOutput, approval_decision: 'approved' },
        });
      }
      await workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'approval_received',
        step_name: approval.nodeId,
        data: { decision: 'approved', comment },
      });
      // For interactive loops, store user input; for standard approvals, mark as approved
      // and clear any rejection state.
      const metadataUpdate =
        approval.type === 'interactive_loop'
          ? { loop_user_input: comment }
          : { approval_response: 'approved', rejection_reason: '', rejection_count: 0 };
      await workflowDb.updateWorkflowRun(runId, {
        status: 'failed',
        metadata: metadataUpdate,
      });

      // Auto-resume: dispatch to the orchestrator so the workflow continues
      // without requiring the user to re-run the workflow command. Mirrors
      // what `workflowApproveCommand` does in the CLI. Requires
      // `parent_conversation_id` on the run (set by orchestrator-agent for any
      // web-dispatched workflow — foreground, interactive, and background via
      // the pre-created run) and a web-platform parent (guarded in the helper).
      const autoResumed = await tryAutoResumeAfterGate(run, 'approve');

      return c.json({
        success: true,
        message: autoResumed
          ? `Workflow approved: ${run.workflow_name}. Resuming workflow.`
          : `Workflow approved: ${run.workflow_name}. Run \`archon workflow resume ${runId}\` from the CLI to continue, or send a new message in the originating conversation.`,
      });
    } catch (error) {
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
      if (run.status !== 'paused') {
        return apiError(c, 400, `Cannot reject workflow in '${run.status}' status`);
      }
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? 'Rejected';
      const approval = run.metadata.approval as ApprovalContext | undefined;
      await workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'approval_received',
        step_name: approval?.nodeId ?? 'unknown',
        data: { decision: 'rejected', reason },
      });

      const hasOnReject = approval?.onRejectPrompt !== undefined;
      if (hasOnReject) {
        const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
        const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
        if (currentCount + 1 >= maxAttempts) {
          await workflowDb.cancelWorkflowRun(runId);
          return c.json({
            success: true,
            message: `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`,
          });
        }
        await workflowDb.updateWorkflowRun(runId, {
          status: 'failed',
          metadata: { rejection_reason: reason, rejection_count: currentCount + 1 },
        });

        // Auto-resume: dispatch to the orchestrator so the on_reject prompt runs
        // without requiring the user to re-run the workflow command. Mirrors
        // what `workflowRejectCommand` does in the CLI. Same cross-adapter
        // guard as approve — only web parents auto-resume.
        const autoResumed = await tryAutoResumeAfterGate(run, 'reject');

        return c.json({
          success: true,
          message: autoResumed
            ? `Workflow rejected: ${run.workflow_name}. Running on-reject prompt.`
            : `Workflow rejected: ${run.workflow_name}. On-reject prompt will run when the run resumes — run \`archon workflow resume ${runId}\` from the CLI to trigger it.`,
        });
      }

      await workflowDb.cancelWorkflowRun(runId);
      return c.json({
        success: true,
        message: `Workflow rejected: ${run.workflow_name}`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_reject_failed');
      return apiError(c, 500, 'Failed to reject workflow run');
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
      if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(
          c,
          400,
          `Cannot delete workflow in '${run.status}' status — cancel it first`
        );
      }
      await workflowDb.deleteWorkflowRun(runId);
      return c.json({ success: true, message: `Deleted workflow run: ${run.workflow_name}` });
    } catch (error) {
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

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
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
      const events = await workflowEventDb.listWorkflowEvents(runId);

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

      return c.json({
        run: {
          ...toApiWorkflowRun(run),
          worker_platform_id: workerPlatformId,
          parent_platform_id: parentPlatformId,
          conversation_platform_id: conversationPlatformId ?? null,
        },
        events,
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return apiError(c, 500, 'Failed to get workflow run');
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
      const result = parseWorkflow(yamlContent, 'validate-input.yaml');

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
    if (!isValidCommandName(name)) {
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

      const filename = `${name}.yaml`;

      // 1. Try user-defined workflow in cwd.
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const filePath = join(workingDir, workflowFolder, filename);
        try {
          const content = await readFile(filePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'project' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_failed');
            return apiError(c, 500, 'Failed to read workflow');
          }
        }
      }

      // 2. Fall back to home-scoped workflow (`~/.archon/workflows/`).
      // Mirrors the discovery order in `discoverWorkflowsWithConfig`.
      {
        const homeFilePath = join(getHomeWorkflowsPath(), filename);
        try {
          const content = await readFile(homeFilePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Home workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'global' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_home_failed');
            return apiError(c, 500, 'Failed to read home-scoped workflow');
          }
        }
      }

      // 3. Fall back to bundled defaults.
      if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
        const bundledContent = BUNDLED_WORKFLOWS[name];
        const result = parseWorkflow(bundledContent, filename);
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({ workflow: result.workflow, filename, source: 'bundled' as WorkflowSource });
      }

      if (!isBinaryBuild()) {
        const defaultFilePath = join(getDefaultWorkflowsPath(), filename);
        try {
          const content = await readFile(defaultFilePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'bundled' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_default_failed');
            return apiError(c, 500, 'Failed to read default workflow');
          }
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

    // Serialize and validate before writing
    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    const parsed = parseWorkflow(yamlContent, `${name}.yaml`);
    if (parsed.error) {
      return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
    }

    try {
      const source: WorkflowSource = targetSource === 'global' ? 'global' : 'project';
      const dirPath =
        source === 'global'
          ? getHomeWorkflowsPath()
          : join(workingDir, getWorkflowFolderSearchPaths()[0]);
      await mkdir(dirPath, { recursive: true });
      const filePath = join(dirPath, `${name}.yaml`);
      await writeFile(filePath, yamlContent, 'utf-8');
      return c.json({
        workflow: parsed.workflow,
        filename: `${name}.yaml`,
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

    // Refuse to delete bundled defaults
    if (targetSource !== 'global' && Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
      return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
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

    const filePath =
      targetSource === 'global'
        ? join(getHomeWorkflowsPath(), `${name}.yaml`)
        : join(workingDir, getWorkflowFolderSearchPaths()[0], `${name}.yaml`);

    try {
      await unlink(filePath);
      return c.json({ deleted: true, name });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, `Workflow not found: ${name}`);
      }
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }
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

      // maxDepth: 1 matches the executor's resolver (resolveCommand /
      // loadCommandPrompt) — without this cap, the UI palette would surface
      // commands buried in deep subfolders that the executor silently can't
      // resolve at runtime.
      const COMMAND_LIST_DEPTH = { maxDepth: 1 };

      // 2. If not binary build, also check filesystem defaults
      if (!isBinaryBuild()) {
        try {
          const defaultsPath = getDefaultCommandsPath();
          const files = await findMarkdownFilesRecursive(defaultsPath, '', COMMAND_LIST_DEPTH);
          for (const { commandName } of files) {
            commandMap.set(commandName, 'bundled');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err }, 'commands.list_defaults_failed');
          }
          // ENOENT: defaults path missing — not an error
        }
      }

      // 3. Home-scoped commands (~/.archon/commands/) override bundled
      try {
        const homeCommandsPath = getHomeCommandsPath();
        const files = await findMarkdownFilesRecursive(homeCommandsPath, '', COMMAND_LIST_DEPTH);
        for (const { commandName } of files) {
          commandMap.set(commandName, 'global');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().error({ err }, 'commands.list_home_failed');
        }
        // ENOENT: home commands dir not created yet — not an error
      }

      // 4. Project-defined commands override bundled AND global
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findMarkdownFilesRecursive(dirPath, '', COMMAND_LIST_DEPTH);
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
    if (!codebase?.name) return c.json({ files: [] });
    const nameParts = codebase.name.split('/');
    if (nameParts.length < 2) return c.json({ files: [] });
    const owner = nameParts[0];
    const repo = nameParts[1];
    if (!owner || !repo) return c.json({ files: [] });

    const artifactDir = getRunArtifactsPath(owner, repo, runId);
    // Defense-in-depth: even though registration sanitises codebase names,
    // ensure the resolved dir stays inside ARCHON_HOME — a maliciously
    // crafted owner/repo containing `..` would otherwise escape the tree.
    const archonHome = getArchonHome();
    const normalisedDir = normalize(artifactDir);
    if (
      !normalisedDir.startsWith(normalize(archonHome) + sep) &&
      normalisedDir !== normalize(archonHome)
    ) {
      getLog().warn({ runId, artifactDir, archonHome }, 'artifacts.path_escape_blocked');
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
        // Skip dotfiles — they're workflow-internal scratch (.pr-number, etc.)
        if (entry.name.startsWith('.')) continue;
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

    // Derive owner/repo from codebase name (format: "owner/repo")
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    if (!codebase?.name) {
      getLog().error({ runId, codebaseId: run.codebase_id }, 'artifacts.codebase_lookup_failed');
      return apiError(c, 404, 'Artifact not available: codebase not found');
    }
    const nameParts = codebase.name.split('/');
    if (nameParts.length < 2) {
      getLog().error({ runId, codebaseName: codebase.name }, 'artifacts.owner_repo_parse_failed');
      return apiError(c, 404, 'Artifact not available: could not determine owner/repo');
    }
    const [owner, repo] = nameParts;

    const artifactDir = getRunArtifactsPath(owner, repo, runId);
    const filePath = join(artifactDir, filename);

    // Final safety check: ensure resolved path stays within artifact directory
    if (
      !normalize(filePath).startsWith(normalize(artifactDir) + sep) &&
      normalize(filePath) !== normalize(artifactDir)
    ) {
      getLog().warn({ runId, filename, filePath, artifactDir }, 'artifacts.path_escape_blocked');
      return apiError(c, 400, 'Invalid filename');
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
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

  // PATCH /api/config/assistants - Update assistant configuration
  registerOpenApiRoute(patchAssistantConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAssistantConfigBodySchema);

      const updates: Partial<GlobalConfig> = {};
      if (body.assistant !== undefined) {
        if (!isRegisteredProvider(body.assistant)) {
          return apiError(
            c,
            400,
            `Unknown provider '${body.assistant}'. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
          );
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
            `Unknown provider(s) in assistants: ${unknownProviders.join(', ')}. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
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
      getLog().error({ err: error }, 'config.assistants_update_failed');
      return apiError(c, 500, 'Failed to update assistant configuration');
    }
  });

  // GET /api/providers - List registered AI providers
  registerOpenApiRoute(getProvidersRoute, c => {
    return c.json({ providers: getProviderInfoList() });
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

  // GET /api/health - Health check with web adapter info
  registerOpenApiRoute(getHealthRoute, async c => {
    const stats = lockManager.getStats();
    const runningWorkflowRows = await workflowDb.getRunningWorkflows();

    // Merge lock-based and DB-based active tracking.
    // Background workflows bypass the lock manager, so we combine both sources.
    const lockActiveSet = new Set(stats.activeConversationIds);
    const backgroundConversationIds = runningWorkflowRows
      .map(r => r.conversation_id)
      .filter(id => !lockActiveSet.has(id));
    const allActiveIds = [...stats.activeConversationIds, ...backgroundConversationIds];

    return c.json({
      status: 'ok',
      adapter: 'web',
      concurrency: {
        ...stats,
        active: allActiveIds.length,
        activeConversationIds: allActiveIds,
      },
      runningWorkflows: runningWorkflowRows.length,
      version: appVersion,
      is_docker: isDocker(),
      activePlatforms: activePlatforms ? [...activePlatforms] : ['Web'],
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
