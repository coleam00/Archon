/**
 * The single type-only touch point for the generated OpenAPI spec.
 *
 * The console isolation guard blocks named imports from `@/lib/api` but allows
 * type-only imports from `@/lib/api.generated`. Every builder module reaches the
 * wire shapes through these two aliases so that generated-spec drift is isolated
 * to this one file. No runtime code lives here.
 */
import type { components } from '@/lib/api.generated';

/** The wire-format DAG node as emitted by the engine's Zod transform. */
export type WireDagNode = components['schemas']['DagNode'];

/** The wire-format workflow definition (name, description, meta, nodes). */
export type WireWorkflowDefinition = components['schemas']['WorkflowDefinition'];
