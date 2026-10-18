import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import * as workflowDb from '@archon/core/db/workflows';
import { RunActionForbiddenError } from '@archon/core/operations/run-authorization';
import {
  assertAnswerAdmissible,
  assertAnswerable,
  assertResponseAccepted,
  attentionAnswerFor,
  expectedGateForOccurrence,
  StaleGateAnswerError,
  type GateAnswerOrigin,
  type WorkflowOperations,
} from '@archon/core/operations/workflow-operations';
import {
  continuablePause,
  isApprovalContext,
  isGateResolved,
  runAttention,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { resolveRunActor } from './api-request-auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
} from './api-route-kit';
import { errorSchema } from './schemas/common.schemas';
import {
  workflowRunActionResponseSchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
  respondWorkflowRunBodySchema,
  answerWorkflowRunBodySchema,
} from './schemas/workflow.schemas';

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

export function registerRunGateRoutes(
  app: OpenAPIHono,
  operations: Pick<
    WorkflowOperations,
    | 'assertRunActionAllowed'
    | 'approveWorkflow'
    | 'rejectWorkflow'
    | 'respondToWorkflow'
    | 'answerWorkflow'
  >
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);
  const {
    assertRunActionAllowed,
    approveWorkflow,
    rejectWorkflow,
    respondToWorkflow,
    answerWorkflow,
  } = operations;

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
}
