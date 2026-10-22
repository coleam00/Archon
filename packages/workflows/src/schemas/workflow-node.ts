import { z } from 'zod';
import { jsonValueSchema } from '../output-ref';
import { dagNodeBaseSchema } from './dag-node-base';

export const numericFanOutParallelismSchema = z
  .number()
  .int()
  .min(1, "'fan_out.max_parallel' must be >= 1");

/**
 * Dynamic fan-out config for a `workflow:` node (#2121 slice 2, PR-C). Expands the
 * node into N governed child runs — one per element of a runtime-length item list —
 * joined into a single node outcome. `items` is a `$node.output[.a.b]` ref that
 * MUST resolve to a JSON array at run time (DATA, per the constitution's
 * §load-time-composition — the child target stays a static name; only the item
 * COUNT is runtime). Each item becomes a child's `input`/`$ARGUMENTS`. Numeric
 * `max_parallel` bounds unfinished children (default 5); `all` uses the resolved item
 * count. Paused children keep their slots until they finish (#4044), so use `all` to
 * expose every independent attention question together. For shared-checkout writes,
 * `max_parallel: 1` keeps children serial. The window caps concurrency, not child count
 * or total spend. Abandon expands at most 500 parents (`MAX_CASCADE_RUNS`), then checks
 * unvisited descendants in one aggregate lookup and warns about unvisited subtrees.
 * The workflow `budget:` does not cover fan-out yet (rejected at load; #2815).
 * `join` reduces child outcomes into the node's `$<id>.output` aggregate:
 *   - `all_done` (DEFAULT): the node succeeds once every child is terminal; failed and
 *      cancelled entries are represented as `{ archon_failed: true, error, status }`
 *      marker objects in the array (`archon_failed` is the reserved discriminator —
 *      a structured child's own payload may legitimately carry `error`/`status`).
 *      Default because fan-out children are independent by default (see the constitution's
 *      independence rule) — two researchers with different scopes, or ten triage children
 *      over ten issues, do not depend on each other, so one failing must not discard the
 *      others' output. Failure is DATA here; deciding how many successes are enough is
 *      judgement and belongs in a downstream node reading the aggregate, never in this enum.
 *   - `all_success`: all must complete; `$<id>.output` = JSON array of child outputs in
 *      item order; any child failing/cancelled fails the node. For the genuinely dependent
 *      case, where the author says so.
 *   - `first_success`: racing — REJECTED, not deferred. A winner aborting and cancelling
 *      the losers couples children's fates, which the constitution's independence rule
 *      forbids, and racing cannot be reshaped without it. The enum value is retained only
 *      so existing YAML gets a message explaining the rejection.
 *
 * `as` names the per-item value as `$INPUTS.<as>` inside each child (#2470 lifted the
 * PR-B/#2214 placeholder now that #2224 merged). It is generally accepted; the superRefine
 * rejects it only when it collides with a `with:` key of the same name (both would populate
 * the same `$INPUTS.<name>` slot). When `as` is unset the item still travels as `$ARGUMENTS`.
 */
export const fanOutConfigSchema = z.object({
  items: z
    .string()
    .min(1, "'fan_out.items' must reference a node output that produces a JSON array"),
  as: z.string().optional(),
  max_parallel: z.union([numericFanOutParallelismSchema, z.literal('all')]).default(5),
  join: z.enum(['all_success', 'all_done', 'first_success']).default('all_done'),
});

export type FanOutConfig = z.infer<typeof fanOutConfigSchema>;

/**
 * Workflow (sub-run) node schema — starts another workflow as a CHILD RUN of the
 * current run at execution time (see executeWorkflowNode in dag/nodes/workflow). Unlike
 * `include:` (which flattens another workflow's nodes into ONE run at load time), a
 * `workflow:` node spawns a genuinely separate `workflow_runs` row with its own
 * artifacts, gates, cost line, and audit trail (#2121 Phase 2). `workflow` is the
 * static target name; `input` is a data string (workflow-vars + `$node.output`
 * substituted) forwarded as the child's user message. `isolation` selects the
 * child's checkout: `'inherit'` (default) shares the parent's checkout; `'worktree'`
 * (slice 2, PR-A) runs the child in its own git worktree via an injected
 * child-isolation resolver — never inferred, including from `fan_out`. `fan_out` (slice 2,
 * PR-C) expands the node into N child runs over a data-driven item list; concurrent
 * children sharing the parent checkout are the author's call to make, declared by
 * `mutates_checkout: false` on the child workflow. `output_type` from the base stays
 * meaningful (typed sidecar). `output_format` is a LOAD ERROR on this node (#2453): the
 * child's `returns:` node owns the result contract, and its declared field names travel
 * back with the result, so `$<id>.output.field` is authorized by the child's schema.
 */
export const workflowNodeSchema = dagNodeBaseSchema.extend({
  kind: z.literal('workflow'),
  workflow: z.string().min(1, "'workflow' must be a non-empty workflow name"),
  input: z.string().optional(),
  // Named inputs passed to the child sub-run as `$INPUTS.<name>` (#2470). Mutually
  // exclusive with `input:`. Same identifier-keyed JSON-value map as `include.with`
  // (#2637): non-string values reach the child with their logical type.
  with: z.record(z.string(), jsonValueSchema).optional(),
  isolation: z.enum(['inherit', 'worktree']).optional(),
  fan_out: fanOutConfigSchema.optional(),
});

/** DAG node that runs another workflow as a governed child sub-run at execution time */
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
