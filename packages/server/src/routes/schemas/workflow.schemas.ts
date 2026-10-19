import {
  toolCallAttentionArraySchema,
  TOOL_CALL_ATTENTION_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import {
  runNodeStateSchema,
  terminalRecordSchema,
} from '@archon/workflows/schemas/terminal-record';
import { providerEventRecordSchema as engineProviderEventRecordSchema } from '@archon/workflows/schemas/provider-event';
/**
 * Zod schemas for workflow API endpoints.
 */
import { z } from '@hono/zod-openapi';
import {
  attentionQueueCountsSchema,
  attentionQueueItemSchema,
} from '@archon/workflows/attention-queue';
import { attentionLabelKeySchema, attentionLabelsSchema } from '@archon/workflows/schemas/dag-node';
import {
  workflowDefinitionSchema as engineWorkflowDefinitionSchema,
  workflowLoadErrorSchema as engineWorkflowLoadErrorSchema,
  workflowSourceSchema as engineWorkflowSourceSchema,
} from '@archon/workflows/schemas/workflow';
import {
  createRunAttentionSchema,
  approvalContextSchema,
  expectedApprovalGateSchema,
  workflowRunSchema as engineWorkflowRunSchema,
  workflowRunOutcomeSchema as engineWorkflowRunOutcomeSchema,
  workflowRunStatusSchema as engineWorkflowRunStatusSchema,
  workflowWaitContextSchema as engineWorkflowWaitContextSchema,
  RUN_STOP_REASON_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import { runStopReasonSchema as engineRunStopReasonSchema } from '@archon/workflows/schemas/run-terminal-reason';
import { nodeCostScopeSchema } from '@archon/workflows/schemas/node-execution';
import { workflowEventRowSchema } from '@archon/core/schemas/workflow-event';
import {
  dashboardWorkflowRunSchema as coreDashboardWorkflowRunSchema,
  runOwnerObservationSchema,
} from '@archon/core/schemas/workflow-run';

/** Workflow definition schema — derived from engine schema via direct subpath import. */
export const workflowDefinitionSchema = engineWorkflowDefinitionSchema.meta({
  id: 'WorkflowDefinition',
});

/** A workflow load error entry returned in GET /api/workflows `errors` field. */
export const workflowLoadErrorSchema = engineWorkflowLoadErrorSchema.meta({
  id: 'WorkflowLoadError',
});

/**
 * Workflow source — project-defined, bundled default, or home-scoped (global).
 * Precedence for same-named entries: `bundled` < `global` < `project`.
 */
export const workflowSourceSchema = engineWorkflowSourceSchema.meta({ id: 'WorkflowSource' });

/** A workflow entry in the list response, including its source. */
export const workflowListEntrySchema = z
  .object({
    workflow: workflowDefinitionSchema,
    source: workflowSourceSchema,
    /**
     * Non-fatal warnings raised while parsing this workflow's YAML — today, keys
     * the engine silently drops (#2213). The workflow still loads and runs;
     * these tell the author what was ignored. Omitted when there are none.
     */
    parseWarnings: z.array(z.string()).optional(),
  })
  .openapi('WorkflowListEntry');

/** GET /api/workflows response. */
export const workflowListResponseSchema = z
  .object({
    workflows: z.array(workflowListEntrySchema),
    /**
     * Repo-owner-curated workflow names from `.archon/config.yaml`
     * `recommendedWorkflows`, filtered to names present in `workflows` and
     * preserved in declared order. Empty when no project context or no key.
     */
    recommended: z.array(z.string()),
    errors: z.array(workflowLoadErrorSchema).optional(),
  })
  .openapi('WorkflowListResponse');

/** GET /api/workflows/:name response. */
export const getWorkflowResponseSchema = z
  .object({
    workflow: workflowDefinitionSchema,
    /**
     * The file's YAML mapping before normalization — the shape an editor must
     * send back to PUT/validate. Absent when the top level is not a mapping.
     */
    authored: z.record(z.string(), z.unknown()).optional(),
    filename: z.string(),
    source: workflowSourceSchema,
  })
  .openapi('GetWorkflowResponse');

/** Request body for workflow definition endpoints (PUT and POST /validate). */
const definitionBodySchema = z.object({ definition: z.record(z.string(), z.unknown()) });

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

/** Workflow run status values, owned by the engine. */
export const workflowRunStatusSchema = engineWorkflowRunStatusSchema.meta({
  id: 'WorkflowRunStatus',
});

/** Workflow-authored verdict, independent from lifecycle status. */
export const workflowRunOutcomeSchema = engineWorkflowRunOutcomeSchema
  .nullable()
  .openapi('WorkflowRunOutcome');

/** Persisted durable-wait cursor exposed to API clients without erasing its discriminants. */
export const workflowWaitContextSchema = engineWorkflowWaitContextSchema.meta({
  id: 'WorkflowWaitContext',
});

/** Why a run stopped, as the engine recorded it on the run row. */
export const runStopReasonSchema = engineRunStopReasonSchema.meta({ id: 'RunStopReason' });

/**
 * Run metadata stays open-ended, but approval, waits, tool advisories and stop reasons are
 * engine-owned and typed.
 */
export const workflowRunMetadataSchema = z
  .object({
    [TOOL_CALL_ATTENTION_METADATA_KEY]: toolCallAttentionArraySchema.optional(),
    approval: approvalContextSchema.optional(),
    wait: workflowWaitContextSchema.optional(),
    [RUN_STOP_REASON_METADATA_KEY]: runStopReasonSchema.optional(),
  })
  .catchall(z.unknown())
  .openapi('WorkflowRunMetadata');

export const RUN_ATTENTION_SCHEMA_NAME = 'RunAttention';
export const runAttentionSchema = createRunAttentionSchema(z.string().datetime()).openapi(
  RUN_ATTENTION_SCHEMA_NAME
);
// OpenAPI 3.0's union null arm needs an explicit type or generated clients erase the entire union.
const nullableRunAttentionSchema = z.union([runAttentionSchema, z.literal(null)]).openapi({
  anyOf: [
    { $ref: `#/components/schemas/${RUN_ATTENTION_SCHEMA_NAME}` },
    { type: 'object', nullable: true, enum: [null] },
  ],
});

const ownerObservationSchema = runOwnerObservationSchema.nullable().openapi({
  description:
    "What this server observes about the running run's execution owner, by the rule `archon workflow wait` uses for `owner_lost`: `reachable` (an owner answers), `unreachable` (the recorded owner is on this server's host and user and nothing answers; the stored status is unchanged and abandoning the run is the operator's call), `unknown` (this server cannot observe the owner: another host or user, no recorded owner, or no answer in time). Null when the run is not running. Observed per request; never stored.",
});

/** A workflow run record (wire shape with ISO string dates). */
export const workflowRunSchema = engineWorkflowRunSchema
  .extend({
    outcome: workflowRunOutcomeSchema,
    metadata: workflowRunMetadataSchema,
    attention: nullableRunAttentionSchema,
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
    cost_scope: nodeCostScopeSchema.optional().openapi({
      description:
        "What `data.cost_usd` measures, by the engine's rule: `own` is the node's own spend; `total` restates spend other rows of the run carry. Present only on rows with a `cost_usd`.",
    }),
  })
  .openapi('WorkflowEvent');

/** GET /api/workflows/runs/:runId response. */
export const workflowRunDetailSchema = z
  .object({
    run: workflowRunSchema.extend({
      worker_platform_id: z.string().optional(),
      parent_platform_id: z.string().optional(),
      conversation_platform_id: z.string().nullable(),
      owner_observation: ownerObservationSchema,
      terminal_record: terminalRecordSchema.nullable(),
      nodes: z.array(runNodeStateSchema).openapi({
        description:
          "The engine's node states: the terminal record's when present, otherwise the engine fold over the events recorded so far.",
      }),
    }),
    events: z.array(workflowEventSchema),
  })
  .openapi('WorkflowRunDetail');

/**
 * One provider event as the engine recorded it: the provider's object in the engine
 * envelope, with its run and node. Derived from the engine schema the store validates
 * against, so the served shape cannot drift from the persisted one.
 */
export const providerEventRecordSchema = engineProviderEventRecordSchema.meta({
  id: 'ProviderEventRecord',
});

/** GET /api/workflows/runs/:runId/provider-events query. */
export const providerEventsQuerySchema = z
  .object({
    step: z.string().min(1).optional().openapi({
      description: 'Only this node (its persisted step name).',
    }),
    attemptId: z.string().min(1).optional().openapi({
      description: 'Cursor attempt. Requires `step` and `afterSeq`.',
    }),
    afterSeq: z.coerce.number().int().nonnegative().optional().openapi({
      description:
        "Cursor seq: return the attempt's events after it and every later attempt's. Requires `step` and `attemptId`.",
    }),
  })
  .refine(q => (q.attemptId === undefined) === (q.afterSeq === undefined), {
    message: 'attemptId and afterSeq must be given together',
  })
  .refine(q => q.attemptId === undefined || q.step !== undefined, {
    message: 'a cursor needs step',
  });

/** GET /api/workflows/runs/:runId/provider-events response. */
export const providerEventsResponseSchema = z
  .object({ events: z.array(providerEventRecordSchema) })
  .openapi('ProviderEventsResponse');

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
  .object({ comment: z.string().optional(), expectedGate: expectedApprovalGateSchema.optional() })
  .openapi('ApproveWorkflowRunBody');

/** POST /api/workflows/runs/:runId/reject request body. */
export const rejectWorkflowRunBodySchema = z
  .object({ reason: z.string().optional(), expectedGate: expectedApprovalGateSchema.optional() })
  .openapi('RejectWorkflowRunBody');

/**
 * POST /api/workflows/runs/:runId/respond request body (#2707 step 2). `decision` must be
 * one of the paused gate's declared decisions; `approve`/`reject` are sugar for the same
 * outcome the dedicated routes above produce.
 */
export const respondWorkflowRunBodySchema = z
  .object({
    decision: z.string().min(1),
    text: z.string().optional(),
    expectedGate: expectedApprovalGateSchema.optional(),
  })
  .openapi('RespondWorkflowRunBody');

/**
 * POST /api/workflows/runs/:runId/answer request body: an answer to a paused attention
 * wait. `occurrence` is the one run-attention reports; an answer for any other occurrence
 * is refused. `choose` holds declared option ids (none for a message form).
 */
export const answerWorkflowRunBodySchema = z
  .object({
    occurrence: z.string(),
    choose: z.array(z.string().min(1)).optional(),
    text: z.string().optional(),
  })
  .openapi('AnswerWorkflowRunBody');

/** DELETE /api/workflows/:name/node-sessions path params. */
export const resetWorkflowNodeSessionsParamsSchema = z
  .object({ name: z.string().min(1) })
  .openapi('ResetWorkflowNodeSessionsParams');

/**
 * DELETE /api/workflows/:name/node-sessions query params.
 *
 * `scope` and `node` narrow the deletion. Omitting `scope` wipes every scope for the
 * workflow — a destructive cross-scope reset that requires `confirm=all-scopes`
 * (mirrors the CLI's `--yes` guard) so it can't happen by an accidentally-dropped param.
 */
export const resetWorkflowNodeSessionsQuerySchema = z
  .object({
    scope: z.string().optional(),
    node: z.string().optional(),
    confirm: z.enum(['all-scopes']).optional(),
  })
  .openapi('ResetWorkflowNodeSessionsQuery');

/** DELETE /api/workflows/:name/node-sessions response. */
export const resetWorkflowNodeSessionsResponseSchema = z
  .object({
    success: z.boolean(),
    deleted: z.number().int().nonnegative(),
  })
  .openapi('ResetWorkflowNodeSessionsResponse');

/** Dashboard enriched workflow run (wire shape with ISO string dates). */
export const dashboardWorkflowRunSchema = coreDashboardWorkflowRunSchema
  .extend({
    metadata: workflowRunMetadataSchema,
    attention: nullableRunAttentionSchema,
    owner_observation: ownerObservationSchema,
    started_at: z.string(),
    completed_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
  })
  .openapi('DashboardWorkflowRun');

/**
 * GET /api/runs/attention query. A server has no working directory, so without
 * `project` the queue is install-wide; `all=true` says so explicitly. `label` repeats.
 */
export const attentionQueueQuerySchema = z.object({
  project: z.string().optional(),
  all: z.enum(['true', 'false']).optional(),
  label: z.union([z.string(), z.array(z.string())]).optional(),
  sort: z.string().optional(),
  countBy: z.string().optional(),
});

/**
 * GET /api/runs/attention list response. `items` is the queue; `runs` holds the same runs
 * as dashboard rows for the console.
 */
export const runsNeedingAttentionResponseSchema = z
  .object({
    runs: z.array(dashboardWorkflowRunSchema),
    items: z.array(attentionQueueItemSchema.meta({ id: 'AttentionQueueItem' })),
  })
  .openapi('RunsNeedingAttentionResponse');

/** GET /api/runs/attention response when `countBy` is given. */
export const attentionQueueCountsResponseSchema = z
  .object({ counts: attentionQueueCountsSchema.meta({ id: 'AttentionQueueCounts' }) })
  .openapi('AttentionQueueCountsResponse');

/** GET /api/runs/{runId}/attention response: null when the run needs no one now. */
export const attentionQueueItemResponseSchema = z
  .object({ item: attentionQueueItemSchema.nullable() })
  .openapi('AttentionQueueItemResponse');

/** POST /api/runs/{runId}/attention/labels body. */
export const labelAttentionBodySchema = z
  .object({
    occurrence: z.string(),
    set: attentionLabelsSchema.optional(),
    unset: z.array(attentionLabelKeySchema).optional(),
  })
  .openapi('LabelAttentionBody');

/** POST /api/runs/{runId}/attention/labels response. */
export const labelAttentionResponseSchema = z
  .object({
    runId: z.string(),
    occurrence: z.string(),
    revision: z.number().int(),
    labels: attentionLabelsSchema,
  })
  .openapi('LabelAttentionResponse');

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
  // Non-enforcing "mine" filter: 'true' restricts to the caller's own runs
  // when an identity resolves. Default lists everything. Enum makes the boolean
  // contract explicit (the handler treats only 'true' as on).
  mine: z.enum(['true', 'false']).optional(),
  // Open-work inbox (#2747): 'true' lists terminal failed runs nothing has
  // adopted or superseded. Mutually exclusive with status/conversationId.
  open: z.enum(['true', 'false']).optional(),
});
