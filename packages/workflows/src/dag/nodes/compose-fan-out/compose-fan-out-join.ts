import { type ProviderFailure } from '@archon/provider-contract';
import type { ComposeFanOutNode } from '../../../schemas';
import { type JsonValue } from '../../../output-ref';
import type { FanOutInstanceSnapshot } from '../../../fan-out-identity';
import { aggregateProviderFailure } from '../../../executor-shared';
import type { ComposeFanOutFailure } from './compose-fan-out-expansion';
import type { ComposeInstanceOutcome } from './compose-fan-out-instance';

/** A composed fan-out join's verdict over every instance outcome, in snapshot order. */
export type ComposeFanOutJoinResult =
  | { status: 'completed'; elements: JsonValue[] }
  | ({ status: 'failed'; providerFailure?: ProviderFailure } & ComposeFanOutFailure);

/**
 * Reduce the instance outcomes through the declared `join`. An ambiguous instance blocks
 * either join. `all_success` fails on the first non-completed instance; `all_done`
 * represents each failure as a marker object in the aggregate.
 */
export function joinComposeOutcomes(
  node: ComposeFanOutNode,
  join: ComposeFanOutNode['fan_out']['join'],
  snapshots: readonly FanOutInstanceSnapshot[],
  outcomes: readonly ComposeInstanceOutcome[]
): ComposeFanOutJoinResult {
  const ambiguous = outcomes.find(outcome => outcome.status === 'ambiguous');
  if (ambiguous !== undefined) {
    const error = ambiguous.error ?? 'a composed instance has ambiguous non-terminal work';
    return {
      status: 'failed',
      error,
      failureKind: 'unknown',
      notice: `❌ **Composed fan-out blocked** (node \`${node.id}\`): ${error}`,
    };
  }

  if (join === 'all_success') {
    const firstBad = outcomes.findIndex(o => o.status !== 'completed');
    if (firstBad !== -1) {
      const bad = outcomes[firstBad];
      const ref = `instance ${snapshots[firstBad].identity}`;
      return {
        status: 'failed',
        error:
          `composed fan_out node '${node.id}' (join: all_success): ${ref} ${bad.status}` +
          (bad.error ? `: ${bad.error}` : ''),
        failureKind: 'child_failed',
        notice:
          `❌ **Composed fan-out failed** (node \`${node.id}\`): ${ref} ${bad.status}` +
          (bad.error ? ` — ${bad.error}` : ''),
        providerFailure: aggregateProviderFailure(
          outcomes.filter(o => o.status !== 'completed').map(o => o.providerFailure),
          Date.now()
        ),
      };
    }
  }

  // all_done represents a failure as a marker object; all_success reaching here is all-completed.
  return {
    status: 'completed',
    elements: outcomes.map(o =>
      o.status === 'completed'
        ? ((o.structuredOutput !== undefined ? o.structuredOutput : o.output) as JsonValue)
        : {
            archon_failed: true,
            error: o.error ?? `instance ${o.status}`,
            status: o.status === 'cancelled' ? 'cancelled' : 'failed',
          }
    ),
  };
}
