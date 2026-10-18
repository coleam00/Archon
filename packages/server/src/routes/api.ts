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
import { readFile, readdir, realpath, stat } from 'fs/promises';
import { readFileSync } from 'fs';
import { normalize, join } from 'path';
import type { Context } from 'hono';
import type {
  ConversationLockManager,
  GlobalConfig,
  TiersPatch,
  SchemaVersionInfo,
} from '@archon/core';
import {
  getDatabaseType,
  getSchemaVersion,
  loadConfig,
  toSafeConfig,
  updateGlobalConfig,
  type CloneOptions,
} from '@archon/core';
import type { AliasesPatch } from '@archon/core';
import { InvalidConfigError } from '@archon/core/config';
import {
  getRunArtifactsDirForRoot,
  isRunArtifactsEngineEntry,
  resolveRunStorageRoot,
  isInsideArchonHome,
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
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  continuablePause,
  isApprovalContext,
  isGateResolved,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { signalWorkflowWaitRequestSchema } from '@archon/core/schemas/workflow-run';
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
  requireWebUser,
  resolveAuthContext,
  resolveRunActor,
} from './api-request-auth';
import { toApiDashboardWorkflowRun, toApiWorkflowRun } from './api-serializers';
import { createOrchestratorDispatch } from './api-message-dispatch';
import { toCleanEntry, validatePresetEntry } from './api-preset-entry';
import { registerAuthRoutes } from './api.auth';
import { registerProviderKeyRoutes } from './api.provider-keys';
import { registerConversationRoutes } from './api.conversations';
import { registerMessageRoutes } from './api.messages';
import { registerCodebaseEnvironmentRoute, registerCodebaseRoutes } from './api.codebases';
import { registerUserAiPrefsRoutes } from './api.user-ai-prefs';
import { registerWorkflowDefinitionRoutes, registerWorkflowListRoute } from './api.workflows';
import { registerWorkflowRunLaunchRoute } from './api.workflow-run-launch';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
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
} from './schemas/workflow.schemas';
import {
  updateAssistantConfigBodySchema,
  updateAssistantConfigResponseSchema,
  configResponseSchema,
  updateTiersBodySchema,
  updateAliasesBodySchema,
} from './schemas/config.schemas';
import { validateAliasName } from './alias-name';
import { TIER_NAMES } from '@archon/workflows/model-validation';
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

// =========================================================================
// Workflow run route configs
// =========================================================================

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
  registerCodebaseRoutes(app, registration);

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

  // Serve OpenAPI spec
  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  registerWorkflowListRoute(app);

  registerWorkflowRunLaunchRoute(app, { webAdapter, dispatchToOrchestrator });

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

  registerWorkflowDefinitionRoutes(app);

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

  registerCodebaseEnvironmentRoute(app);

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
