/**
 * Zod schemas for workflow API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { workflowDefinitionSchema as engineWorkflowDefinitionSchema } from '@archon/workflows/schemas/workflow';
import { workflowRunSchema as engineWorkflowRunSchema } from '@archon/workflows/schemas/workflow-run';
import { workflowEventRowSchema } from '@archon/core/schemas/workflow-event';
import { dashboardWorkflowRunSchema as coreDashboardWorkflowRunSchema } from '@archon/core/schemas/workflow-run';

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

/**
 * Workflow source — project-defined, bundled default, or home-scoped (global).
 * Precedence for same-named entries: `bundled` < `global` < `project`.
 */
export const workflowSourceSchema = z
  .enum(['project', 'bundled', 'global'])
  .openapi('WorkflowSource');

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

/** A workflow run record (wire shape with ISO string dates). */
export const workflowRunSchema = engineWorkflowRunSchema
  .extend({
    started_at: z.string(),
    completed_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
  })
  .openapi('WorkflowRun');

/** GET /api/workflows/runs response. */
export const workflowRunListResponseSchema = z
  .object({ runs: z.array(workflowRunSchema) })
  .openapi('WorkflowRunListResponse');

/** A workflow event record (wire shape). */
export const workflowEventSchema = workflowEventRowSchema
  .extend({
    created_at: z.string().datetime(),
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

/** Dashboard enriched workflow run (wire shape with ISO string dates). */
export const dashboardWorkflowRunSchema = coreDashboardWorkflowRunSchema
  .extend({
    started_at: z.string(),
    completed_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
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

/** A single artifact file listed by GET /api/runs/:runId/artifacts. */
export const artifactFileSchema = z
  .object({
    path: z.string(),
    size: z.number().int().nonnegative(),
    modifiedAt: z.string(),
  })
  .openapi('ArtifactFile');

/** GET /api/runs/:runId/artifacts response. */
export const listArtifactsResponseSchema = z
  .object({
    files: z.array(artifactFileSchema),
  })
  .openapi('ListArtifactsResponse');

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
