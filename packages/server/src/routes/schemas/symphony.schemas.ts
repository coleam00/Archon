/**
 * Zod schemas for the `/api/symphony/*` namespace.
 *
 * Symphony is the autonomous Linear+GitHub tracker dispatcher that lives in
 * `packages/symphony` and launches Archon workflow runs per active issue.
 * Routes are only registered when `~/.archon/symphony.yaml` exists at server
 * startup; missing config → routes 404 silently.
 */
import { z } from '@hono/zod-openapi';

// ---------------------------------------------------------------------------
// Snapshot view (running / retrying / completed counts)
// ---------------------------------------------------------------------------

export const symphonyTrackerKindSchema = z
  .enum(['linear', 'github'])
  .openapi('SymphonyTrackerKind');

export const symphonyDispatchStatusSchema = z
  .enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
  .openapi('SymphonyDispatchStatus');

export const symphonyRunningRowSchema = z
  .object({
    dispatch_key: z.string(),
    tracker: symphonyTrackerKindSchema,
    issue_id: z.string(),
    issue_identifier: z.string(),
    state: z.string(),
    started_at: z.string(),
    workflow_run_id: z.string().nullable(),
  })
  .openapi('SymphonyRunningRow');

export const symphonyRetryRowSchema = z
  .object({
    dispatch_key: z.string(),
    tracker: symphonyTrackerKindSchema,
    issue_id: z.string(),
    issue_identifier: z.string(),
    attempt: z.number().int().nonnegative(),
    due_at: z.string(),
    error: z.string().nullable(),
  })
  .openapi('SymphonyRetryRow');

export const symphonyStateResponseSchema = z
  .object({
    generated_at: z.string(),
    counts: z.object({
      running: z.number().int().nonnegative(),
      retrying: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
    }),
    running: z.array(symphonyRunningRowSchema),
    retrying: z.array(symphonyRetryRowSchema),
  })
  .openapi('SymphonyStateResponse');

// ---------------------------------------------------------------------------
// Dispatch row listing (matches `symphony_dispatches` columns)
// ---------------------------------------------------------------------------

export const symphonyDispatchRowSchema = z
  .object({
    id: z.string(),
    issue_id: z.string(),
    identifier: z.string(),
    tracker: symphonyTrackerKindSchema,
    dispatch_key: z.string(),
    codebase_id: z.string().nullable(),
    workflow_name: z.string(),
    workflow_run_id: z.string().nullable(),
    attempt: z.number().int().nonnegative(),
    dispatched_at: z.string(),
    status: symphonyDispatchStatusSchema,
    last_error: z.string().nullable(),
  })
  .openapi('SymphonyDispatchRow');

export const symphonyDispatchListResponseSchema = z
  .object({
    dispatches: z.array(symphonyDispatchRowSchema),
  })
  .openapi('SymphonyDispatchListResponse');

export const symphonyListDispatchesQuerySchema = z
  .object({
    status: symphonyDispatchStatusSchema.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  })
  .openapi('SymphonyListDispatchesQuery');

// ---------------------------------------------------------------------------
// Action requests
// ---------------------------------------------------------------------------

export const symphonyDispatchActionBodySchema = z
  .object({
    dispatch_key: z
      .string()
      .min(1)
      .describe("Source-aware dispatch key, e.g. 'linear:APP-123' or 'github:owner/repo#42'"),
  })
  .openapi('SymphonyDispatchActionBody');

export const symphonyDispatchActionResponseSchema = z
  .object({
    ok: z.boolean(),
    dispatch_key: z.string().optional(),
    code: z.string().optional(),
    reason: z.string().optional(),
  })
  .openapi('SymphonyDispatchActionResponse');

export const symphonyRefreshResponseSchema = z
  .object({
    coalesced: z.boolean(),
  })
  .openapi('SymphonyRefreshResponse');
