/**
 * Which of a node's dependencies changed since a prior pass recorded them. Resume uses
 * it twice: a cached prior success is reusable only when no dependency changed (#2402),
 * and an answered wait applies its stored answer only on the same condition, because
 * the answer was given to the question those dependencies rendered.
 */
import type { DagNode, NodeOutput } from '../schemas';
import type { PersistedNodeOutput } from '../store';

/**
 * `true` when two structured-output payloads are semantically equal for the
 * purposes of cache invalidation. JSON.stringify is the comparison because
 * structured outputs are persisted as JSONB — they are guaranteed JSON-shaped
 * (objects/arrays/primitives, no cycles, no functions). `undefined` is treated
 * as the absent payload; an explicit `null` is a real value and is distinct
 * from absent.
 */
function structuredOutputsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function isReplayedFailure(
  depId: string,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  replayedFailures: ReadonlyMap<string, unknown> | undefined
): boolean {
  return nodeOutputs.get(depId)?.state === 'failed' && replayedFailures?.has(depId) === true;
}

function cachedOutputIsStale(
  prior: PersistedNodeOutput | undefined,
  current: NodeOutput | undefined
): boolean {
  if (current?.state === 'failed') return true;
  if (prior === undefined) return current?.state === 'completed';
  if (current?.output !== prior.output) return true;
  const currentStructured =
    current !== undefined && 'structuredOutput' in current ? current.structuredOutput : undefined;
  return !structuredOutputsEqual(prior.structuredOutput, currentStructured);
}

/**
 * Return the IDs of `node`'s dependencies whose current `nodeOutputs` value no
 * longer matches their cached `priorCompletedNodes` snapshot (#2402). A
 * downstream consumer that is being considered for a prior-success skip is
 * stale — it was last computed against the prior snapshot, not against the
 * current `nodeOutputs` — when any of its deps is in this set. The set is
 * built by comparing text output AND structured output so consumers using
 * `$node.output.field` (the #2637 logical-value surface) are also invalidated
 * when only the structured form changed.
 *
 * A dep currently in `state: 'failed'` is always stale, checked first and
 * unconditionally — regardless of whether it had a prior cached success. Every
 * failure arm in the executor returns `output: ''`, so comparing a fresh
 * failure's value against a prior success's value (cases 2/3 below) can find
 * them equal and silently miss the failure; a dependency that failed on THIS
 * resume must never be judged by value equality. The one exception is a failure
 * replayed from the prior pass (`replayedFailures`): the dependent was computed on
 * that same failure, so it is not stale.
 *
 * Past that, three cases surface a dep as "ran fresh this resume":
 *
 * 1. The dep was never in `priorCompletedNodes` at all (never completed in the
 *    prior run, or never reached) and is now `completed` in `nodeOutputs` — it
 *    re-ran this resume with no prior cache to honour. `'skipped'` is
 *    intentionally left out: its `output: ''` is semantically equivalent to
 *    the absent prior, so honouring the cache is safe.
 * 2. The dep's `prior.output` differs from `nodeOutputs.get(dep).output` —
 *    either an `always_run` upstream that re-executed, or any dep the engine
 *    re-ran with new content. The per-layer aggregation is the only writer of
 *    `nodeOutputs[dep].output` other than the pre-population loop, so a diff is
 *    proof of fresh execution.
 * 3. The dep's `prior.structuredOutput` differs from the current one — a
 *    subtler staleness that only matters for `$dep.output.field` consumers,
 *    covered here so a fresh structured value can't slip past a text-stable
 *    cache. JSON.stringify is sufficient: structured outputs are persisted to
 *    JSONB and therefore JSON-serializable; for `undefined` vs absent values,
 *    `JSON.stringify` normalises both to a missing key.
 *
 * Note: the value-equality comparison (cases 2/3) is conservative in one
 * direction — a dep that re-ran with text- and structured-identical output
 * will NOT be flagged. The cached downstream is therefore semantically
 * equivalent to a fresh execution in that case, which is the safe direction
 * to err in (over-run vs. stale success is the bug we're closing). The
 * failed-state check above is not subject to this leniency: a failure is
 * never treated as equivalent to the prior success it's compared against.
 */
export function getStaleCachedDependencies(
  node: DagNode,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  priorCompletedNodes: ReadonlyMap<string, PersistedNodeOutput>,
  replayedFailures?: ReadonlyMap<string, unknown>
): string[] {
  // A failure replayed from the prior pass is the state its dependents were computed on.
  const deps = (node.depends_on ?? []).filter(
    depId => !isReplayedFailure(depId, nodeOutputs, replayedFailures)
  );
  return deps.filter(depId =>
    cachedOutputIsStale(priorCompletedNodes.get(depId), nodeOutputs.get(depId))
  );
}
