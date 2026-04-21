/**
 * Zod schemas for workflow API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { workflowDefinitionSchema as engineWorkflowDefinitionSchema } from '@harneeslab/workflows/schemas/workflow';

/** Workflow definition schema — derived from engine schema via direct subpath import. */
export const workflowDefinitionSchema =
  engineWorkflowDefinitionSchema.openapi('WorkflowDefinition');

/** A workflow load error entry returned in GET /api/workflows `errors` field. */
export const workflowLoadErrorSchema = z
  .object({
    filename: z.string(),
    error: z.string(),
    errorType: z.enum(['read_error', 'parse_error', 'validation_error']),
  })
  .openapi('WorkflowLoadError');

/** Workflow source — project-defined or bundled default. */
export const workflowSourceSchema = z.enum(['project', 'bundled']).openapi('WorkflowSource');

/** A workflow entry in the list response, including its source. */
export const workflowListEntrySchema = z
  .object({
    workflow: workflowDefinitionSchema,
    source: workflowSourceSchema,
  })
  .openapi('WorkflowListEntry');

/** GET /api/workflows response. */
export const workflowListResponseSchema = z
  .object({
    workflows: z.array(workflowListEntrySchema),
    errors: z.array(workflowLoadErrorSchema).optional(),
  })
  .openapi('WorkflowListResponse');

/** GET /api/workflows/:name response. */
export const getWorkflowResponseSchema = z
  .object({
    workflow: workflowDefinitionSchema,
    filename: z.string(),
    source: workflowSourceSchema,
  })
  .openapi('GetWorkflowResponse');

/** Request body for workflow definition endpoints (PUT and POST /validate). */
const definitionBodySchema = z.object({ definition: z.record(z.unknown()) });

/** PUT /api/workflows/:name request body. */
export const saveWorkflowBodySchema = definitionBodySchema.openapi('SaveWorkflowBody');

/** POST /api/workflows/validate request body. */
export const validateWorkflowBodySchema = definitionBodySchema.openapi('ValidateWorkflowBody');

/** POST /api/workflows/validate response. */
export const validateWorkflowResponseSchema = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string()).optional(),
  })
  .openapi('ValidateWorkflowResponse');

/** DELETE /api/workflows/:name response. */
export const deleteWorkflowResponseSchema = z
  .object({ deleted: z.boolean(), name: z.string() })
  .openapi('DeleteWorkflowResponse');

/** A single command entry returned by GET /api/commands. */
export const commandEntrySchema = z
  .object({
    name: z.string(),
    source: workflowSourceSchema,
  })
  .openapi('CommandEntry');

/** GET /api/commands response. */
export const commandListResponseSchema = z
  .object({ commands: z.array(commandEntrySchema) })
  .openapi('CommandListResponse');

// =========================================================================
// Workflow run schemas
// =========================================================================

/** Workflow run status values. */
export const workflowRunStatusSchema = z
  .enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'paused'])
  .openapi('WorkflowRunStatus');

/** A workflow run record. */
export const workflowRunSchema = z
  .object({
    id: z.string(),
    workflow_name: z.string(),
    conversation_id: z.string(),
    parent_conversation_id: z.string().nullable(),
    codebase_id: z.string().nullable(),
    status: workflowRunStatusSchema,
    user_message: z.string(),
    metadata: z.record(z.unknown()),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
    working_path: z.string().nullable(),
  })
  .openapi('WorkflowRun');

/** GET /api/workflows/runs response. */
export const workflowRunListResponseSchema = z
  .object({ runs: z.array(workflowRunSchema) })
  .openapi('WorkflowRunListResponse');

/** A workflow event record. */
export const workflowEventSchema = z
  .object({
    id: z.string(),
    workflow_run_id: z.string(),
    event_type: z.string(),
    step_index: z.number().nullable(),
    step_name: z.string().nullable(),
    data: z.record(z.unknown()),
    created_at: z.string(),
  })
  .openapi('WorkflowEvent');

/** GET /api/workflows/runs/:runId response. */
export const workflowRunDetailSchema = z
  .object({
    run: workflowRunSchema.extend({
      worker_platform_id: z.string().optional(),
      parent_platform_id: z.string().optional(),
      conversation_platform_id: z.string().nullable(),
    }),
    events: z.array(workflowEventSchema),
  })
  .openapi('WorkflowRunDetail');

/** GET /api/workflows/runs/by-worker/:platformId response. */
export const workflowRunByWorkerResponseSchema = z
  .object({ run: workflowRunSchema })
  .openapi('WorkflowRunByWorkerResponse');

/** POST /api/workflows/runs/:runId/cancel response. */
export const cancelWorkflowRunResponseSchema = z
  .object({ success: z.boolean(), message: z.string() })
  .openapi('CancelWorkflowRunResponse');

/** Generic workflow run action response (resume, abandon, delete). */
export const workflowRunActionResponseSchema = z
  .object({ success: z.boolean(), message: z.string() })
  .openapi('WorkflowRunActionResponse');

/** POST /api/workflows/runs/:runId/approve request body. */
export const approveWorkflowRunBodySchema = z
  .object({ comment: z.string().optional() })
  .openapi('ApproveWorkflowRunBody');

/** POST /api/workflows/runs/:runId/reject request body. */
export const rejectWorkflowRunBodySchema = z
  .object({ reason: z.string().optional() })
  .openapi('RejectWorkflowRunBody');

/** Dashboard enriched workflow run (with joined codebase/conversation data). */
export const dashboardWorkflowRunSchema = workflowRunSchema
  .extend({
    codebase_name: z.string().nullable(),
    platform_type: z.string().nullable(),
    worker_platform_id: z.string().nullable(),
    parent_platform_id: z.string().nullable(),
    current_step_name: z.string().nullable(),
    total_steps: z.number().nullable(),
    current_step_status: z.enum(['running', 'completed', 'failed']).nullable(),
    agents_completed: z.number().nullable(),
    agents_failed: z.number().nullable(),
    agents_total: z.number().nullable(),
  })
  .openapi('DashboardWorkflowRun');

/** GET /api/dashboard/runs response. */
export const dashboardRunsResponseSchema = z
  .object({
    runs: z.array(dashboardWorkflowRunSchema),
    total: z.number(),
    counts: z.object({
      all: z.number(),
      running: z.number(),
      completed: z.number(),
      failed: z.number(),
      cancelled: z.number(),
      pending: z.number(),
      paused: z.number(),
    }),
  })
  .openapi('DashboardRunsResponse');

/** POST /api/workflows/:name/run request body. */
export const runWorkflowBodySchema = z
  .object({
    conversationId: z.string(),
    message: z.string(),
  })
  .openapi('RunWorkflowBody');

/** GET /api/dashboard/runs query params. */
export const dashboardRunsQuerySchema = z.object({
  // z.string() — handler validates the enum value and ignores invalid values
  status: z.string().optional(),
  codebaseId: z.string().optional(),
  search: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/** GET /api/workflows/runs query params. */
export const workflowRunsQuerySchema = z.object({
  conversationId: z.string().optional(),
  // z.string() — handler validates the enum value and ignores invalid values
  status: z.string().optional(),
  codebaseId: z.string().optional(),
  limit: z.string().optional(),
});
