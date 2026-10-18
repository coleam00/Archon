import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import * as conversationDb from '@archon/core/db/conversations';
import * as workflowDb from '@archon/core/db/workflows';
import { RunActionForbiddenError } from '@archon/core/operations/run-authorization';
import {
  AbandonOwnerNotStoppedError,
  AbandonRefusedError,
  CancelRefusedError,
  describeAbandonOwner,
  describeReleasedWorktrees,
  type WorkflowOperations,
} from '@archon/core/operations/workflow-operations';
import { signalWorkflowWaitRequestSchema } from '@archon/core/schemas/workflow-run';
import { createSqlWorkflowHost } from '@archon/core/workflows/sql-host';
import { createWorkflowStore } from '@archon/core/workflows/store-adapter';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import { isConversationOwnershipEnforced } from '../auth';
import { resumeWorkflowRunFromServer } from '../services/workflow-resume-service';
import type { OrchestratorDispatch } from './api-message-dispatch';
import { authorizeConversation, resolveRunActor } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import {
  cancelWorkflowRunResponseSchema,
  resetWorkflowNodeSessionsParamsSchema,
  resetWorkflowNodeSessionsQuerySchema,
  resetWorkflowNodeSessionsResponseSchema,
  workflowRunActionResponseSchema,
} from './schemas/workflow.schemas';

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

export function registerRunControlRoutes(
  app: OpenAPIHono,
  {
    operations,
    dispatchToOrchestrator,
  }: {
    operations: Pick<
      WorkflowOperations,
      | 'assertRunActionAllowed'
      | 'cancelWorkflow'
      | 'resumeWorkflow'
      | 'signalWorkflowWait'
      | 'abandonWorkflow'
    >;
    dispatchToOrchestrator: OrchestratorDispatch;
  }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const {
    assertRunActionAllowed,
    cancelWorkflow,
    resumeWorkflow,
    signalWorkflowWait,
    abandonWorkflow,
  } = operations;

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
}

export function registerRunCleanupRoutes(
  app: OpenAPIHono,
  operations: Pick<
    WorkflowOperations,
    'assertRunActionAllowed' | 'deleteWorkflowRun' | 'resetWorkflowNodeSessions'
  >
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const { assertRunActionAllowed, deleteWorkflowRun, resetWorkflowNodeSessions } = operations;

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
}
