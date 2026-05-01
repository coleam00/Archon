/**
 * Zod schemas for Compass API endpoints.
 *
 * Compass is a visual canvas that overlays proposed ("ghost") features on top
 * of an extracted graph of the codebase's existing features ("real"), with
 * AI-driven drift scoring against a per-codebase north star.
 */
import { z } from '@hono/zod-openapi';

// =========================================================================
// Codebase path params
// =========================================================================

export const compassCodebaseIdParamsSchema = z
  .object({ codebaseId: z.string().openapi({ example: 'abc123' }) })
  .openapi('CompassCodebaseIdParams');

// =========================================================================
// Real feature graph (extracted from the codebase)
// =========================================================================

export const realFeatureKindSchema = z
  .enum(['route', 'endpoint', 'workflow', 'component', 'module'])
  .openapi('RealFeatureKind');

export const realFeatureNodeSchema = z
  .object({
    id: z.string(),
    kind: realFeatureKindSchema,
    label: z.string(),
    filePath: z.string(),
    lineStart: z.number().int().nonnegative().optional(),
    lineEnd: z.number().int().nonnegative().optional(),
    exports: z.array(z.string()).optional(),
    imports: z.array(z.string()).optional(),
  })
  .openapi('RealFeatureNode');

export const realFeatureEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    kind: z.enum(['imports', 'calls', 'triggers']),
  })
  .openapi('RealFeatureEdge');

// =========================================================================
// North star (per-codebase product objectives)
// =========================================================================

export const objectiveSchema = z
  .object({
    id: z.string(),
    one_liner: z.string(),
    examples_of_drift: z.array(z.string()).default([]),
  })
  .openapi('CompassObjective');

export const northStarSchema = z
  .object({ objectives: z.array(objectiveSchema) })
  .openapi('CompassNorthStar');

// =========================================================================
// Ghost annotation (AI output for a ghost node)
// =========================================================================

export const annotationCitationSchema = z
  .object({
    path: z.string(),
    lineStart: z.number().int().nonnegative().optional(),
    lineEnd: z.number().int().nonnegative().optional(),
    why: z.string(),
  })
  .openapi('CompassAnnotationCitation');

export const annotationAlignmentSchema = z
  .enum(['strengthens', 'weakens', 'neutral'])
  .openapi('CompassAnnotationAlignment');

export const annotationScopeSchema = z
  .enum(['1h', 'half-day', 'multi-day'])
  .openapi('CompassAnnotationScope');

export const annotationSchema = z
  .object({
    drift_score: z.number().min(0).max(10),
    north_star_alignment: z.record(annotationAlignmentSchema),
    scope: annotationScopeSchema,
    citations: z.array(annotationCitationSchema),
    dependencies: z.array(z.string()),
    why_now: z.string(),
    generated_at: z.string(),
  })
  .openapi('CompassAnnotation');

// =========================================================================
// Ghost feature node (user-proposed candidates)
// =========================================================================

export const ghostStatusSchema = z
  .enum(['draft', 'queued', 'promoted'])
  .openapi('CompassGhostStatus');

export const compassPositionSchema = z
  .object({ x: z.number(), y: z.number() })
  .openapi('CompassPosition');

export const ghostFeatureNodeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    notes: z.string().optional(),
    position: compassPositionSchema,
    status: ghostStatusSchema,
    annotation: annotationSchema.nullable(),
    promoted_target: z.enum(['issue', 'workflow', 'queue']).nullable(),
    promoted_ref: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('CompassGhostFeatureNode');

// =========================================================================
// GET /api/compass/:codebaseId/graph
// =========================================================================

export const compassGraphResponseSchema = z
  .object({
    realNodes: z.array(realFeatureNodeSchema),
    realEdges: z.array(realFeatureEdgeSchema),
    ghostNodes: z.array(ghostFeatureNodeSchema),
    northStar: northStarSchema.nullable(),
    lastScannedAt: z.string().nullable(),
    scanWarnings: z.array(z.string()).default([]),
  })
  .openapi('CompassGraphResponse');

// =========================================================================
// POST /api/compass/:codebaseId/ghosts (upsert)
// =========================================================================

export const upsertGhostBodySchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1),
    notes: z.string().optional(),
    position: compassPositionSchema,
  })
  .openapi('CompassUpsertGhostBody');

export const upsertGhostResponseSchema = z
  .object({ ghost: ghostFeatureNodeSchema })
  .openapi('CompassUpsertGhostResponse');

// =========================================================================
// DELETE /api/compass/:codebaseId/ghosts/:ghostId
// =========================================================================

export const compassGhostIdParamsSchema = z
  .object({
    codebaseId: z.string(),
    ghostId: z.string(),
  })
  .openapi('CompassGhostIdParams');

export const deleteGhostResponseSchema = z
  .object({ deleted: z.boolean(), id: z.string() })
  .openapi('CompassDeleteGhostResponse');

// =========================================================================
// POST /api/compass/:codebaseId/annotate
// =========================================================================

export const annotateGhostBodySchema = z
  .object({ ghostId: z.string() })
  .openapi('CompassAnnotateGhostBody');

export const annotateGhostResponseSchema = z
  .object({
    ghost: ghostFeatureNodeSchema,
    annotation: annotationSchema,
  })
  .openapi('CompassAnnotateGhostResponse');

// =========================================================================
// POST /api/compass/:codebaseId/promote
// =========================================================================

export const promoteTargetSchema = z
  .enum(['issue', 'workflow', 'queue'])
  .openapi('CompassPromoteTarget');

export const promoteGhostBodySchema = z
  .object({
    ghostId: z.string(),
    target: promoteTargetSchema,
  })
  .openapi('CompassPromoteGhostBody');

export const promoteGhostResponseSchema = z
  .object({
    ghost: ghostFeatureNodeSchema,
    issueUrl: z.string().nullable(),
    conversationId: z.string().nullable(),
  })
  .openapi('CompassPromoteGhostResponse');
