/**
 * The single type-only touch point for the generated OpenAPI spec.
 *
 * The console isolation guard blocks named imports from `@/lib/api` but allows
 * type-only imports from `@/lib/api.generated`. Every builder module reaches the
 * wire shapes through these two aliases so that generated-spec drift is isolated
 * to this one file. No runtime code lives here.
 */
import type { components } from '@/lib/api.generated';

interface WireRouteLoopRoutes {
  positive: string;
  negative: string;
  exhausted: string;
}

interface WireRouteLoopConfig {
  from: string;
  condition: string;
  routes: WireRouteLoopRoutes;
  max_iterations: number;
}

type GeneratedWireDagNode = components['schemas']['DagNode'];

/** The wire-format DAG node as emitted by the engine's Zod transform. */
export type WireDagNode = GeneratedWireDagNode & {
  route_loop?: WireRouteLoopConfig;
};

/** The wire-format workflow definition (name, description, meta, nodes). */
export type WireWorkflowDefinition = components['schemas']['WorkflowDefinition'];
