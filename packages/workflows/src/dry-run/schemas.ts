import { z } from 'zod';
import { effortLevelSchema, skipCauseSchema, workflowRunOutcomeSchema } from '../schemas';

const dryRunNodeTypeSchema = z.enum([
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'loop_group',
  'approval',
  'wait',
  'cancel',
  'include',
  'workflow',
  'compose_fan_out',
]);
export type DryRunNodeType = z.infer<typeof dryRunNodeTypeSchema>;

/**
 * Where a node's provider/model will come from at run time.
 *
 * The reason this is reported rather than required per node: after composition collapses a
 * workflow's config onto its own nodes (#1764), the honest answer to "what will this node
 * run on" is a chain, and making every node restate provider+model to make it visible
 * would be ~54 redundant lines in a 27-node workflow. Legibility instead of redundancy.
 */
const dryRunResolutionSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: effortLevelSchema.optional(),
  /** Where each value came from — 'node', 'model ref', 'workflow', 'assistant config', … */
  providerFrom: z.string(),
  modelFrom: z.string(),
  effortFrom: z.string(),
  /** The workflow file this node was authored in, when it arrived through `include:`. */
  authoredIn: z.string().optional(),
  /**
   * Set when the node names one provider while its `model:` ref resolves to another. A
   * real run warns the user about this and uses the resolved provider; a dry run that
   * silently omitted it would report the outcome without the reason for it.
   */
  providerConflict: z
    .object({ declared: z.string(), resolved: z.string(), modelRef: z.string() })
    .optional(),
});
export type DryRunResolution = z.infer<typeof dryRunResolutionSchema>;

const dryRunTraceBaseSchema = z.object({
  nodeId: z.string(),
  nodeType: dryRunNodeTypeSchema,
  resolvedText: z.string().optional(),
  output: z.string().optional(),
  iteration: z.number().int().positive().optional(),
  /** Present for nodes that take an AI turn; absent for bash/script/approval/cancel. */
  resolution: dryRunResolutionSchema.optional(),
});

export const dryRunTraceEntrySchema = z.discriminatedUnion('state', [
  dryRunTraceBaseSchema.extend({
    state: z.literal('completed'),
    reason: z.string().optional(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('stubbed'),
    reason: z.string().optional(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('skipped'),
    reason: z.string(),
    cause: skipCauseSchema,
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('failed'),
    reason: z.string(),
  }),
  dryRunTraceBaseSchema.extend({
    state: z.literal('paused'),
    reason: z.string(),
  }),
]);
export type DryRunTraceEntry = z.infer<typeof dryRunTraceEntrySchema>;

export const dryRunResultSchema = z.object({
  workflow: z.string(),
  outcome: z.enum(['completed', 'failed', 'paused', 'cancelled']),
  authoredOutcome: workflowRunOutcomeSchema.nullable(),
  trace: z.array(dryRunTraceEntrySchema),
  missingStubs: z.array(z.string()),
  /**
   * The subset of `missingStubs` a `trigger_rule: all_done` join tolerated (#2869) —
   * hydrated with a generated placeholder rather than failing the node. Always a
   * subset of `missingStubs`, never a replacement for it: a consumer that only cares
   * about genuinely blocking gaps filters `missingStubs` by this list; one that wants
   * every unverified node (the pre-#2869 contract) keeps reading `missingStubs` alone.
   */
  toleratedMissingStubs: z.array(z.string()),
  unusedStubs: z.array(z.string()),
  summary: z.string().optional(),
});
export type DryRunResult = z.infer<typeof dryRunResultSchema>;
