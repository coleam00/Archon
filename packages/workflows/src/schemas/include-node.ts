import { z } from 'zod';
import { jsonValueSchema } from '../output-ref';
import { dagNodeBaseSchema } from './dag-node-base';
import { fanOutConfigSchema, numericFanOutParallelismSchema } from './workflow-node';

/**
 * Include directive schema — a load-time-only graph-construction directive, not a
 * `DagNode` (#2486). It carries no execution surface of its own: `include` is the
 * target workflow name, `with` is its load-time input mapping, and the structural
 * graph fields (id / depends_on / when / trigger_rule) attach the expanded sub-DAG.
 * `expandWorkflowIncludes` (include-expander.ts) consumes every `IncludeDirective`
 * at discovery time; by the time a `WorkflowDefinition` reaches the executor, none
 * survive — `dag/dispatch.ts` asserts this defensively rather than dispatching on it,
 * since `IncludeDirective` is not a member of the `DagNode` union it type-checks against.
 */
export const includeDirectiveSchema = dagNodeBaseSchema
  .pick({
    id: true,
    description: true,
    depends_on: true,
    when: true,
    trigger_rule: true,
  })
  .extend({
    kind: z.literal('include'),
    include: z.string().min(1, "'include' must be a non-empty workflow name"),
    // JSON-compatible input values (#2637): strings splice into text surfaces via
    // the load-time macro; non-string values keep their logical type through the
    // declared-input contract and canonicalize to JSON text where spliced.
    with: z.record(z.string(), jsonValueSchema).optional(),
  });

/** Load-time-only graph-construction directive — inlines another workflow's nodes at discovery time */
export type IncludeDirective = z.infer<typeof includeDirectiveSchema>;

/** Composed fan-out always names the item binding; it has no `$ARGUMENTS` fallback. */
export const composeFanOutConfigSchema = fanOutConfigSchema.extend({
  max_parallel: numericFanOutParallelismSchema.default(5),
  as: z
    .string({
      error:
        "'fan_out.as' is required on an include node so each runtime item has an explicit $INPUTS.<name> binding",
    })
    .min(1, "'fan_out.as' is required on an include node and must be a non-empty input name"),
});

/**
 * Deferred composition fan-out (#2512) — an `include:` node that also declares
 * `fan_out:`. Unlike a plain `IncludeDirective` it is NOT expanded away at load time:
 * the item list is runtime data, so the width of the expansion is unknowable until
 * execution. `expandWorkflowIncludes` leaves the node in place (validating the target
 * name resolves) and the executor expands the target once per item at run time through
 * the same expander, under a per-instance `<nodeId>__<identity>` namespace — one parent
 * run row, events under the parent's id, no child runs.
 *
 * Deliberately NOT spelled `workflow:` + `fan_out:` (the issue's illustrative YAML is
 * declared non-final): that spelling already means governed per-item child runs, and
 * re-purposing it would silently reinterpret live workflows the issue requires be
 * "continued safely ... not silently converted".
 */
export const composeFanOutNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('compose_fan_out'),
  include: z.string().min(1, "'include' must be a non-empty workflow name"),
  with: z.record(z.string(), jsonValueSchema).optional(),
  fan_out: composeFanOutConfigSchema,
});

export type ComposeFanOutNode = z.infer<typeof composeFanOutNodeSchema>;
