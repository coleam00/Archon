import { z } from 'zod';
import { providerFailureSchema } from '@archon/provider-contract';
import { declaredOutputPathsSchema } from '../output-ref';
import { nodeExecutionMetadataSchema, nodeFailureKindSchema } from './node-execution';
import { skipCauseSchema, type NodeState } from './node-state';

/**
 * Captured output from a completed DAG node.
 * `output` is the concatenated assistant text (or JSON-encoded string from the SDK
 * when output_format is set). Empty string for a skipped/pending node; for a FAILED
 * node it is usually empty too, but not always — a `loop_group`'s failure paths
 * (body-node failure, `max_iterations` exhaustion, cancellation) deliberately carry
 * the last completed iteration's real, non-empty output. No reader of a 'failed'
 * node's `output` may treat it as trustworthy regardless of content (#2713).
 * `error` is required when state is 'failed', absent on all other states.
 * `cause` is required when state is 'skipped' so downstream decisions retain its provenance.
 * `structuredOutput` carries the provider's parsed structured payload (set by Pi/Codex/Claude
 * when the result chunk includes one). Downstream `$nodeId.output.field` substitution and
 * `when:` conditions prefer this object over re-parsing `output`, so providers that emit
 * fence-wrapped or preamble-prefixed JSON (Pi/Minimax) survive the round-trip.
 * `declaredOutputPaths` is every object-field path a producer's `output_format` schema
 * declares, captured when the node completes. The consumer uses it to tell a
 * declared-but-optional-absent field (resolves to `''`) from a path not in the contract
 * at all (a typo → throws). Undefined for non-schema producers (bash/script/prose) and
 * schemas without a `properties` map.
 */
export const nodeOutputSchema = z.discriminatedUnion('state', [
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.enum(['completed', 'running']),
    output: z.string(),
    sessionId: z.string().optional(),
    structuredOutput: z.unknown().optional(),
    declaredOutputPaths: declaredOutputPathsSchema.optional(),
    /** Session-resume outcome from the provider: false ⇒ a requested resume came
     *  back cold (fresh session). Drives the executor's cold-resume warning.
     *  Absent on 'failed' nodes — the retry path, not this signal, handles those. */
    resumed: z.boolean().optional(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('failed'),
    output: z.string(),
    sessionId: z.string().optional(),
    error: z.string(),
    structuredOutput: z.unknown().optional(),
    declaredOutputPaths: declaredOutputPathsSchema.optional(),
    /** Set by a producer whose failure is a deterministic diagnosis of its own output
     *  (an exec node's stdout missing its declared `output_format`): re-running yields
     *  the same stdout, so the retry loop must not consult the error text, which quotes
     *  that stdout and can read as transient. Only `false` is expressible: a producer can
     *  refuse retry, never force one past a FATAL classification. */
    retryable: z.literal(false).optional(),
    /** Why the node failed, when the producer knows it (see `nodeFailureKindSchema`). */
    failureKind: nodeFailureKindSchema.optional(),
    /** The provider's own typed failure, unchanged, when a provider reported one. */
    providerFailure: providerFailureSchema.optional(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('pending'),
    output: z.string(),
  }),
  z.object({
    execution: nodeExecutionMetadataSchema.optional(),
    state: z.literal('skipped'),
    output: z.string(),
    cause: skipCauseSchema,
  }),
]);

export type NodeOutput = z.infer<typeof nodeOutputSchema>;

// ---------------------------------------------------------------------------
// Compile-time assertion: NodeOutput must cover all NodeState values.
// If NodeState gains a new value, this line becomes a type error as a reminder
// to update NodeOutput.
// ---------------------------------------------------------------------------

type AssertNodeOutputCoversNodeState = NodeOutput['state'] extends NodeState
  ? NodeState extends NodeOutput['state']
    ? true
    : never
  : never;
const nodeOutputStateCoverage: AssertNodeOutputCoversNodeState = true;
void nodeOutputStateCoverage; // suppress unused-variable lint warning
