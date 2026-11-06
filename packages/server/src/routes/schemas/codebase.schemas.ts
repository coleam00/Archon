/**
 * Zod schemas for codebase API endpoints.
 */
import { z } from '@hono/zod-openapi';
import {
  codebaseRowSchema,
  codebaseSourceSchema,
  codebaseSourceError,
  projectBaseBranchInspectionSchema,
} from '@archon/core/schemas/codebase';

/** A codebase record (wire shape with ISO string dates). */
export const codebaseSchema = codebaseRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Codebase');

/** GET /api/codebases response. */
export const codebaseListResponseSchema = z.array(codebaseSchema).openapi('CodebaseListResponse');

/** Path params for routes with :id (codebase ID). */
export const codebaseIdParamsSchema = z.object({ id: z.string() });

const registrationFields = { base_branch: z.string().trim().min(1).nullable().optional() };
/** POST /api/codebases request body. Exactly one of url or path must be provided. */
export const addCodebaseBodySchema = z
  .union(
    [
      codebaseSourceSchema.options[0].extend(registrationFields),
      codebaseSourceSchema.options[1].extend({
        ...registrationFields,
        folder: z.boolean().optional(),
      }),
    ],
    { error: codebaseSourceError }
  )
  .openapi('AddCodebaseBody');

/** PATCH /api/codebases/:id request body. */
export const renameCodebaseBodySchema = z
  .object({ name: z.string().trim().min(1).max(255) })
  .strict()
  .openapi('RenameCodebaseBody');

/** DELETE /api/codebases/:id response. */
export const deleteCodebaseResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteCodebaseResponse');

/** Response for GET /api/codebases/:id/env — returns only keys, never values */
export const codebaseEnvVarsResponseSchema = z
  .object({
    keys: z.array(z.string()),
  })
  .openapi('CodebaseEnvVarsResponse');

/** Body for PUT /api/codebases/:id/env — upsert one key-value pair */
export const setEnvVarBodySchema = z
  .object({
    key: z.string().min(1).max(255),
    value: z.string(),
  })
  .openapi('SetEnvVarBody');

/** Path params for routes with :id/:key */
export const codebaseEnvVarParamsSchema = z.object({
  id: z.string(),
  key: z.string(),
});

/** Response for PUT/DELETE /api/codebases/:id/env */
export const envVarMutationResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('EnvVarMutationResponse');

/** What was last synced for one extra workflow source. */
export const extraSourceSnapshotSchema = z
  .object({
    commit: z.string(),
    synced_at: z.string().datetime(),
    /** False when the repository had no remote and the ref was read locally. */
    fetched: z.boolean(),
  })
  .openapi('ExtraWorkflowSourceSnapshot');

export const extraSourceStatusSchema = z
  .object({
    ref: z.string(),
    path: z.string(),
    /** Null until the source is first synced. */
    snapshot: extraSourceSnapshotSchema.nullable(),
  })
  .openapi('ExtraWorkflowSourceStatus');

/** GET /api/codebases/:id/extra-sources and POST /api/codebases/:id/sync response. */
export const extraSourcesResponseSchema = z
  .object({ sources: z.array(extraSourceStatusSchema) })
  .openapi('ExtraWorkflowSourcesResponse');

export const inspectBaseBranchBodySchema = codebaseSourceSchema.openapi('InspectBaseBranchBody');

export const inspectBaseBranchResponseSchema = projectBaseBranchInspectionSchema.openapi(
  'InspectBaseBranchResponse'
);
