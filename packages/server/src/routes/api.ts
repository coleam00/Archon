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
import { hostname, userInfo, uptime as osUptime } from 'os';
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
  getRunArtifactsPath,
  getArchonHome,
  isDocker,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { parseWorkflow } from '@archon/workflows/loader';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import { isValidCommandName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
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
import { errorSchema } from './schemas/common.schemas';
import { updateCheckResponseSchema, operatorResponseSchema } from './schemas/system.schemas';
import {
  workflowListResponseSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  testRunWorkflowBodySchema,
  testRunWorkflowResponseSchema,
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
  runWorkflowBodySchema,
  dashboardRunsQuerySchema,
  workflowRunsQuerySchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
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
import { getProviderInfoList, isRegisteredProvider } from '@archon/providers';
import type { SymphonyServiceHandle } from '@archon/symphony';
import { getSymphonyEventEmitter, type SymphonyEmitterEvent } from '@archon/symphony/event-emitter';
import { buildReplayPreview, launchReplay } from '../replay';

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

/**
 * Map a filename's extension to a MIME type. Used by the artifact handlers so
 * videos, images, PDFs, and structured text all serve with the right
 * Content-Type. Anything unrecognised falls back to application/octet-stream
 * so the browser doesn't try to render arbitrary binary as text.
 */
function mimeFor(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'md':
    case 'markdown':
      return 'text/markdown; charset=utf-8';
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8';
    case 'txt':
    case 'log':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

const cwdQuerySchema = z.object({ cwd: z.string().optional() });

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

const testRunWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/test-run',
  tags: ['Workflows'],
  summary: 'Run an in-memory workflow definition without persisting it',
  request: {
    body: {
      content: { 'application/json': { schema: testRunWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: testRunWorkflowResponseSchema } },
      description: 'Test run dispatched',
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
    query: cwdQuerySchema,
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
    query: cwdQuerySchema,
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

const runWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/{name}/run',
  tags: ['Workflows'],
  summary: 'Run a workflow via the orchestrator',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: { 'application/json': { schema: runWorkflowBodySchema } },
      required: true,
    },
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
  summary: 'Resume a failed workflow run (re-run auto-resumes from completed nodes)',
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
              concurrency: z.record(z.unknown()),
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              activePlatforms: z.array(z.string()).optional(),
              symphony: z
                .object({
                  generated_at: z.string(),
                  counts: z.object({
                    running: z.number(),
                    retrying: z.number(),
                    completed: z.number(),
                  }),
                  running: z.array(z.record(z.unknown())),
                  retrying: z.array(z.record(z.unknown())),
                })
                .nullable()
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

const getOperatorRoute = createRoute({
  method: 'get',
  path: '/api/operator',
  tags: ['System'],
  summary: 'Operator identity for the running server',
  responses: {
    200: {
      content: { 'application/json': { schema: operatorResponseSchema } },
      description: 'Operator name, host, and process uptime',
    },
  },
});

/**
 * Translate a SymphonyEmitterEvent to its Mission Control wire payload.
 * The wire `type` is prefixed with `symphony_` so the frontend store can
 * dispatch on the same channel that carries workflow events.
 */
function mapSymphonyEvent(event: SymphonyEmitterEvent): string {
  const { type, ...rest } = event;
  return JSON.stringify({
    type: `symphony_${type}`,
    ...rest,
    timestamp: Date.now(),
  });
}

/**
 * Boot-time sweep: remove orphaned `_testrun_*.yaml` files older than 1 hour.
 *
 * Test-run files are written by `POST /api/workflows/test-run` and normally
 * cleaned up when the run reaches a terminal status. A crashed daemon can leave
 * them behind — this catches those across all registered codebases.
 *
 * Exported (rather than inlined into `registerApiRoutes`) so route-level tests
 * that mock `listCodebases` once-only do not get their mocks consumed by the
 * sweep on every test setup.
 */
export async function sweepOrphanTestRunFiles(): Promise<void> {
  try {
    const codebases = await codebaseDb.listCodebases();
    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const cb of codebases) {
      const dir = join(cb.default_cwd, workflowFolder);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().debug({ err: e, dir }, 'workflow.test_run_sweep_readdir_failed');
        }
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith('_testrun_') || !name.endsWith('.yaml')) continue;
        const fp = join(dir, name);
        try {
          const st = await stat(fp);
          if (now - st.mtimeMs > ONE_HOUR) {
            await unlink(fp);
            getLog().info({ filePath: fp }, 'workflow.test_run_orphan_swept');
          }
        } catch (err) {
          getLog().debug({ err, filePath: fp }, 'workflow.test_run_sweep_entry_failed');
        }
      }
    }
  } catch (err) {
    getLog().warn({ err }, 'workflow.test_run_sweep_failed');
  }
}

/**
 * Register all /api/* routes on the Hono app.
 */
export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[],
  symphonyHandle?: SymphonyServiceHandle
): void {
  function apiError(
    c: Context,
    status: 400 | 404 | 422 | 500,
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
      return c.json(conversations);
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
      return c.json(conv);
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
        codebaseId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          await messageDb.addMessage(conversation.id, 'user', message);
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

        const result = await dispatchToOrchestrator(conversation.platform_conversation_id, message);

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
      // Normalize metadata: PostgreSQL JSONB auto-deserializes to object,
      // but frontend expects JSON string. SQLite returns string already.
      return c.json(
        messages.map(m => ({
          ...m,
          metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata),
        }))
      );
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return apiError(c, 500, 'Failed to list messages');
    }
  });

  // POST /api/conversations/:id/message - Send message
  // Manual body parsing: multipart uses parseBody(), JSON uses req.json().
  registerOpenApiRoute(sendMessageRoute, async c => {
    const conversationId = c.req.param('id') ?? '';

    // Reject conversation IDs that could be used for path traversal when building
    // the upload directory. Web conversation IDs are alphanumeric with hyphens only.
    if (!/^[\w-]+$/.test(conversationId)) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    let message: string;
    const savedFiles: AttachedFile[] = [];
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

      // Enforce server-side file count limit
      const fileEntries = fileList.filter((e): e is File => e instanceof File);
      if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
        return c.json({ error: `Maximum ${String(MAX_FILES_PER_MESSAGE)} files per message` }, 400);
      }

      const archonHome = getArchonHome();
      uploadDir = join(archonHome, 'artifacts', 'uploads', conversationId);

      // Guard against path traversal in conversationId (belt-and-suspenders after regex above)
      if (!uploadDir.startsWith(archonHome + sep)) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
      }

      // Validate all files before writing any to disk
      for (const entry of fileEntries) {
        const displayName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        // Server-side MIME type allowlist (client-side accept= is not a security boundary;
        // entry.type is the Content-Type supplied by the client and is not verified against
        // actual file contents — suitable for a single-developer self-hosted tool)
        if (!isAllowedUploadType(entry.type, entry.name)) {
          return c.json(
            { error: `File "${displayName}" has an unsupported type: ${entry.type}` },
            400
          );
        }
        if (entry.size > MAX_UPLOAD_BYTES) {
          return c.json({ error: `File "${displayName}" exceeds the 10 MB size limit` }, 400);
        }
      }

      // Write files; on any failure clean up already-written files and surface the error
      try {
        await mkdir(uploadDir, { recursive: true });
        for (const entry of fileEntries) {
          const fileId = randomUUID();
          const safeName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = join(uploadDir, `${fileId}_${safeName}`);
          await writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
          // Normalise MIME: strip parameters to prevent prompt injection via crafted Content-Type
          const normalizedMime =
            entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
          savedFiles.push({
            path: filePath,
            // Use safeName for display to avoid prompt injection via crafted filenames
            name: safeName || fileId,
            mimeType: normalizedMime,
            size: entry.size,
          });
        }
      } catch (writeErr: unknown) {
        // Roll back any files written before the failure
        for (const f of savedFiles) {
          await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
            }
          });
        }
        getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
        return c.json({ error: 'Failed to save uploaded file. Check available disk space.' }, 500);
      }

      getLog().info({ conversationId, fileCount: savedFiles.length }, 'message.files_uploaded');
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
        await messageDb.addMessage(conv.id, 'user', message, meta);
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
    let extraContext: Omit<HandleMessageContext, 'isolationHints'> | undefined;
    let filesToCleanup: { files: AttachedFile[]; uploadDir: string } | undefined;
    if (savedFiles.length > 0) {
      extraContext = { attachedFiles: savedFiles };
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

  // GET /api/mission/stream — Mission Control SSE (workflow events + Symphony dispatch events)
  // Workflow events arrive via the WorkflowEventBridge fan-out (already wired to '__mission__').
  // Symphony dispatch events are subscribed in-handler and prefixed with `symphony_dispatch_*`
  // so the frontend store can route cleanly.
  app.get('/api/mission/stream', async c => {
    return streamSSE(c, async stream => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream('__mission__', stream);
      getLog().debug({ streamId: '__mission__' }, 'mission_sse_opened');

      const symphonyUnsubscribe = getSymphonyEventEmitter().subscribe(
        (event: SymphonyEmitterEvent) => {
          const wireEvent = mapSymphonyEvent(event);
          webAdapter.emitMissionEvent(wireEvent);
        }
      );

      stream.onAbort(() => {
        getLog().debug({ streamId: '__mission__' }, 'mission_sse_disconnected');
        symphonyUnsubscribe();
        webAdapter.removeStream('__mission__', stream);
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
          getLog().warn({ err: e as Error }, 'mission_sse_heartbeat_error');
        }
      } finally {
        symphonyUnsubscribe();
        webAdapter.removeStream('__mission__', stream);
        getLog().debug({ streamId: '__mission__' }, 'mission_sse_closed');
      }
    });
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

      return c.json(
        deduped.map(cb => {
          let commands = cb.commands;
          if (typeof commands === 'string') {
            try {
              commands = JSON.parse(commands);
            } catch (parseErr) {
              getLog().error({ err: parseErr, codebaseId: cb.id }, 'corrupted_commands_json');
              commands = {};
            }
          }
          return { ...cb, commands };
        })
      );
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
      let commands = codebase.commands;
      if (typeof commands === 'string') {
        try {
          commands = JSON.parse(commands);
        } catch (parseErr) {
          getLog().error({ err: parseErr, codebaseId: codebase.id }, 'corrupted_commands_json');
          commands = {};
        }
      }
      return c.json({ ...codebase, commands });
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

      return c.json(codebase, result.alreadyExisted ? 200 : 201);
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
      let workingDir = cwd;

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

      if (!workingDir) {
        return c.json({ workflows: [] });
      }

      const result = await discoverWorkflowsWithConfig(workingDir, loadConfig);
      return c.json({
        // Hide internal test-run scratch files from the dropdown.
        workflows: result.workflows
          .filter(ws => !ws.workflow.name.startsWith('_testrun_'))
          .map(ws => ({ workflow: ws.workflow, source: ws.source })),
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
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!isValidCommandName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }
    try {
      const { conversationId, message } = getValidatedBody(c, runWorkflowBodySchema);
      // Persist user message and register DB ID (same as message endpoint)
      let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
      try {
        conv = await conversationDb.findConversationByPlatformId(conversationId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
      }
      if (conv) {
        try {
          await messageDb.addMessage(conv.id, 'user', message);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        // Generate title for sidebar (fire-and-forget)
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
      const result = await dispatchToOrchestrator(conversationId, fullMessage);
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
      const dashboardValidStatuses = [
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
        'paused',
      ] as const;
      type DashboardRunStatus = (typeof dashboardValidStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (dashboardValidStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const errorClass = c.req.query('errorClass')?.trim() || undefined;
      const cursor = c.req.query('cursor')?.trim() || undefined;
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
        errorClass,
        cursor,
      });
      return c.json(result);
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
      await workflowDb.cancelWorkflowRun(runId);
      return c.json({ success: true, message: `Cancelled workflow: ${run.workflow_name}` });
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
      // Run is already failed — the next invocation on the same path auto-resumes
      const pathInfo = run.working_path ? ` at \`${run.working_path}\`` : '';
      return c.json({
        success: true,
        message: `Workflow run ready to resume: ${run.workflow_name}${pathInfo}. Re-run the workflow to auto-resume from completed nodes.`,
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
          : `Workflow approved: ${run.workflow_name}. Send a message to continue.`,
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
            : `Workflow rejected: ${run.workflow_name}. On-reject prompt will run on resume.`,
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

  // POST /api/workflows/runs/:runId/replay
  // Body: { confirm?: boolean } — when omitted or false, returns a preview drift
  // block; when true, launches a fresh workflow run with `replay_of_run_id` set.
  // NOTE: Uses app.post() instead of registerOpenApiRoute because the response
  // shape varies (preview vs launch).
  app.post('/api/workflows/runs/:runId/replay', async c => {
    const runId = c.req.param('runId') ?? '';
    let body: { confirm?: boolean } = {};
    try {
      const text = await c.req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text) as { confirm?: boolean };
      }
    } catch {
      // Treat invalid JSON as preview request — common for GET-style probes.
      body = {};
    }

    if (body.confirm !== true) {
      const preview = await buildReplayPreview(runId);
      if (!preview.ok) return apiError(c, preview.status, preview.error);
      return c.json({ mode: 'preview', preview: preview.preview });
    }

    const launch = await launchReplay(runId, webAdapter);
    if (!launch.ok) return apiError(c, launch.status, launch.error);
    return c.json({ mode: 'launched', result: launch.result });
  });

  // GET /api/workflows/runs - List workflow runs
  registerOpenApiRoute(listWorkflowRunsRoute, async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = [
        'pending',
        'running',
        'completed',
        'failed',
        'cancelled',
        'paused',
      ] as const;
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
      return c.json({ runs });
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
      return c.json({ run });
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
          ...run,
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

  // POST /api/workflows/test-run - Run an in-memory workflow without persisting it.
  // MUST be registered before GET /api/workflows/:name so "test-run" is not treated as :name.
  // Strategy: write the definition to `<cwd>/.archon/workflows/_testrun_<uuid>.yaml`, dispatch
  // through the existing executor, and unlink on terminal status. The temp filename is also
  // filtered out of GET /api/workflows so the dropdown stays clean.
  registerOpenApiRoute(testRunWorkflowRoute, async c => {
    const { definition, codebaseId, cwd, message } = getValidatedBody(c, testRunWorkflowBodySchema);

    // Resolve workingDir from cwd / codebaseId / first codebase, in that order.
    let workingDir: string | undefined = cwd;
    if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else if (codebaseId) {
      const cb = await codebaseDb.getCodebase(codebaseId);
      if (!cb) return apiError(c, 400, 'Codebase not found');
      workingDir = cb.default_cwd;
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      return apiError(c, 400, 'No working directory could be resolved for the test run');
    }

    const tempName = `_testrun_${randomUUID()}`;

    // Force the workflow's name to match the temp filename so internal references line up.
    const definitionWithName: Record<string, unknown> = {
      ...definition,
      name: tempName,
    };

    // Validate before writing.
    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definitionWithName);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, tempName }, 'workflow.test_run_serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }
    const parsed = parseWorkflow(yamlContent, `${tempName}.yaml`);
    if (parsed.error) {
      return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
    }

    // Write the temp file under the codebase's .archon/workflows/.
    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const dirPath = join(workingDir, workflowFolder);
    const filePath = join(dirPath, `${tempName}.yaml`);
    try {
      await mkdir(dirPath, { recursive: true });
      await writeFile(filePath, yamlContent, 'utf-8');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, tempName, filePath }, 'workflow.test_run_write_failed');
      return apiError(c, 500, 'Failed to stage temp workflow file');
    }

    // Hook one-shot cleanup: unlink the temp file when the run reaches a terminal state.
    // Safety net: unconditionally unlink after 1 hour even if no terminal event arrives.
    const emitter = getWorkflowEventEmitter();
    let runId: string | null = null;
    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        await unlink(filePath);
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, tempName, filePath }, 'workflow.test_run_cleanup_failed');
        }
      }
    };
    const unsubscribe = emitter.subscribe((ev: WorkflowEmitterEvent) => {
      // Capture the runId once we see this temp workflow start.
      if (ev.type === 'workflow_started' && ev.workflowName === tempName && !runId) {
        runId = ev.runId;
        return;
      }
      if (
        runId &&
        ev.runId === runId &&
        (ev.type === 'workflow_completed' ||
          ev.type === 'workflow_failed' ||
          ev.type === 'workflow_cancelled')
      ) {
        unsubscribe();
        clearTimeout(safetyTimer);
        void cleanup();
      }
    });
    const safetyTimer = setTimeout(
      () => {
        unsubscribe();
        void cleanup();
        getLog().info({ tempName, filePath }, 'workflow.test_run_safety_cleanup');
      },
      60 * 60 * 1000
    );
    if (typeof safetyTimer === 'object' && 'unref' in safetyTimer) {
      (safetyTimer as { unref: () => void }).unref();
    }

    // Create a fresh conversation for this test run so it stays isolated from any
    // existing chat thread.
    const platformConvId = `web-testrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let conversation: Awaited<ReturnType<typeof conversationDb.getOrCreateConversation>>;
    try {
      conversation = await conversationDb.getOrCreateConversation(
        'web',
        platformConvId,
        codebaseId ?? undefined
      );
    } catch (error) {
      unsubscribe();
      clearTimeout(safetyTimer);
      void cleanup();
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, tempName }, 'workflow.test_run_conv_create_failed');
      return apiError(c, 500, 'Failed to create test-run conversation');
    }
    webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);
    await conversationDb.updateConversationTitle(
      conversation.id,
      `Test run · ${tempName.slice(9, 17)}`
    );

    const dispatchMessage = `/workflow run ${tempName}${message ? ` ${message}` : ''}`;
    try {
      await messageDb.addMessage(conversation.id, 'user', dispatchMessage);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
    }

    let dispatchResult: Awaited<ReturnType<typeof dispatchToOrchestrator>>;
    try {
      dispatchResult = await dispatchToOrchestrator(
        conversation.platform_conversation_id,
        dispatchMessage
      );
    } catch (error) {
      unsubscribe();
      clearTimeout(safetyTimer);
      void cleanup();
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, tempName }, 'workflow.test_run_dispatch_failed');
      return apiError(c, 500, 'Failed to dispatch test run');
    }

    return c.json({
      tempName,
      conversationId: conversation.platform_conversation_id,
      ...dispatchResult,
    });
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

      // 1. Try user-defined workflow in cwd
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

      // 2. Try home-scoped workflow (~/.archon/workflows/{name}.yaml)
      {
        const homeWorkflowPath = join(getArchonHome(), 'workflows', filename);
        try {
          const content = await readFile(homeWorkflowPath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Home workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'project' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_home_failed');
            return apiError(c, 500, 'Failed to read home workflow');
          }
        }
      }

      // 3. Fall back to bundled defaults (binary: embedded map; dev: also check filesystem)
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
      const [workflowFolder] = getWorkflowFolderSearchPaths();
      const dirPath = join(workingDir, workflowFolder);
      await mkdir(dirPath, { recursive: true });
      const filePath = join(dirPath, `${name}.yaml`);
      await writeFile(filePath, yamlContent, 'utf-8');
      return c.json({
        workflow: parsed.workflow,
        filename: `${name}.yaml`,
        source: 'project' as WorkflowSource,
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

    // Refuse to delete bundled defaults
    if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
      return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
    }

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
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const filePath = join(workingDir, workflowFolder, `${name}.yaml`);

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

  // GET /api/artifacts/:runId - Directory manifest of all artifact files for a run
  // Returns { files: [{ path, name, size, mimeType, createdAt }] }. Walks the
  // run artifacts directory recursively. Skips dotfiles. Caps at 1000 entries
  // (more than enough — runs that need more probably want pagination).
  app.get('/api/artifacts/:runId', async c => {
    const runId = c.req.param('runId');

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
    if (!run) return apiError(c, 404, 'Workflow run not found');

    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    if (!codebase?.name) return apiError(c, 404, 'Artifact not available: codebase not found');
    const nameParts = codebase.name.split('/');
    if (nameParts.length < 2) {
      return apiError(c, 404, 'Artifact not available: could not determine owner/repo');
    }
    const [owner, repo] = nameParts;
    const artifactDir = getRunArtifactsPath(owner, repo, runId);

    interface FileEntry {
      path: string;
      name: string;
      size: number;
      mimeType: string;
      createdAt: string;
    }
    const files: FileEntry[] = [];
    const MAX = 1000;
    async function walk(dir: string, prefix: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        if (files.length >= MAX) return;
        if (e.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs, rel);
        } else if (e.isFile()) {
          const s = await stat(abs);
          files.push({
            path: rel,
            name: e.name,
            size: s.size,
            mimeType: mimeFor(e.name),
            createdAt: s.birthtime.toISOString(),
          });
        }
      }
    }
    try {
      await walk(artifactDir, '');
    } catch (err) {
      getLog().error({ err, runId, artifactDir }, 'artifacts.manifest_failed');
      return apiError(c, 500, 'Failed to list artifacts');
    }
    return c.json({ files });
  });

  // GET /api/artifacts/:runId/* - Serve workflow artifact file contents
  // The wildcard captures the filename (e.g. "plan.md", "subdir/report.md" or
  // "screen.mp4"). Path traversal is blocked: any segment containing ".." is
  // rejected. Binary-safe: streams via Bun.file; honors Range for video
  // scrubbing.
  // NOTE: Uses app.get() instead of registerOpenApiRoute because:
  //  1. Wildcard path params (*) are not representable in OpenAPI 3.0
  //  2. Response is raw bytes (image/video/markdown/...), not JSON
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

    // Stat first so we know the size (needed for Range responses) and can 404
    // before opening the file.
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.stat_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }
    if (!fileStat.isFile()) return apiError(c, 404, 'Artifact file not found');

    const contentType = mimeFor(filename);
    const totalSize = fileStat.size;
    const range = c.req.header('range');

    // Range request — needed for video scrubbing.
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const startStr = match[1];
        const endStr = match[2];
        const start = startStr ? parseInt(startStr, 10) : 0;
        const end = endStr ? parseInt(endStr, 10) : totalSize - 1;
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          end < totalSize &&
          start <= end
        ) {
          const slice = Bun.file(filePath).slice(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${String(start)}-${String(end)}/${String(totalSize)}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Cache-Control': 'private, max-age=60',
            },
          });
        }
      }
    }

    return new Response(Bun.file(filePath), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(totalSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=60',
      },
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
      symphony: symphonyHandle?.orchestrator.getSnapshotView() ?? null,
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

  registerOpenApiRoute(getOperatorRoute, async c => {
    return c.json({
      name: userInfo().username,
      host: hostname(),
      uptimeSeconds: Math.floor(osUptime()),
    });
  });
}
