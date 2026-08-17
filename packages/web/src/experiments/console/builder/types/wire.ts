/**
 * The single type-only touch point for the generated OpenAPI spec.
 *
 * The console isolation guard blocks named imports from `@/lib/api` but allows
 * type-only imports from `@/lib/api.generated`. Every builder module reaches the
 * wire shapes through these two aliases so that generated-spec drift is isolated
 * to this one file. No runtime code lives here.
 */
import type { components } from '@/lib/api.generated';

type GeneratedDagNode = components['schemas']['DagNode'];

/**
 * The wire-format DAG node as emitted by the engine's Zod transform.
 *
 * `loop.until` is relaxed to optional here. #2563 made it optional on the engine
 * schema — a loop may declare only `until_bash` and then has no prose completion
 * path at all — but `api.generated.d.ts` is regenerated against a running server
 * and is not part of `bun run validate`, so the checked-in spec still marks it
 * required. This file is the declared home for generated-spec drift, so the
 * override lives here rather than at the call sites. It becomes redundant (not
 * wrong) after the next regeneration; delete it then.
 */
export type WireDagNode = Omit<GeneratedDagNode, 'loop'> & {
  loop?: Omit<NonNullable<GeneratedDagNode['loop']>, 'until'> & { until?: string };
};

/**
 * The wire-format workflow definition (name, description, meta, nodes).
 *
 * `nodes` is re-pointed at the local {@link WireDagNode} so the `loop.until`
 * relaxation above reaches the exporter; without it the generated `DagNode[]`
 * would reject a node the builder can legitimately produce. Same lifetime as that
 * override — both go away on the next spec regeneration.
 */
export type WireWorkflowDefinition = Omit<components['schemas']['WorkflowDefinition'], 'nodes'> & {
  nodes: WireDagNode[];
};
