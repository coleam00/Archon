/**
 * Write the work order the run's message named, approved by the run's user, and start
 * intake on each member it has not seen.
 *
 * The run builds nothing: the scheduled build queue with `orders_only` claims the
 * members, each only once intake has triaged it and it waits for the build queue. The
 * write is conditional on the order not existing, so an id already taken refuses the
 * run instead of replacing an order someone approved.
 *
 * Bound inputs: INPUTS_REPO from start, INPUTS_ORDER (id, members, unresolved) from interpret.
 */

import { launchDetached } from '../../.shared/launch.ts';
import { emit, nullableJson, refuse, workflowRunId } from '../../.shared/io.ts';
import { ORDER_PREFIX, parseWorkOrder, type WorkOrder } from '../../.shared/order.ts';
import { runUser, statePut } from '../../.shared/state.ts';
import { readWorkItem } from '../../.shared/workitem.ts';

interface Declared {
  readonly id: string;
  readonly members: readonly number[];
  readonly unresolved: readonly { readonly named: string; readonly why: string }[];
}

function main(): void {
  const runId = workflowRunId();
  const declared = nullableJson(process.env.INPUTS_ORDER) as Declared;
  const name = `${ORDER_PREFIX}${declared.id}`;
  const by = runUser(runId);
  if (by === null) throw new Error(`the run records no user to approve ${name}; write it with archon state put`);
  const order: WorkOrder = parseWorkOrder({
    version: 1,
    // A member named twice is one member, and gets one intake run.
    members: [...new Set(declared.members)],
    approved: { by, at: new Date().toISOString() },
    status: 'open',
    done_at: null,
  });
  if (statePut(name, order, 0) === 'conflict') {
    throw new Error(`${name} already exists; name the order differently, or edit it at its current revision`);
  }

  const repo = nullableJson(process.env.INPUTS_REPO) as { host: string; path: string };
  const unseen = order.members.filter(number => readWorkItem(number) === null);
  const intake = unseen.map(number => {
    const run = launchDetached('archon-intake', { repo_host: repo.host, repo_path: repo.path, number: String(number) });
    return `#${String(number)} (intake run ${run})`;
  });
  const lines = [
    `Wrote ${name} with members ${order.members.map(number => `#${String(number)}`).join(', ')}, approved by ${by}; the scheduled build queue with orders_only builds each once intake has triaged it.`,
    ...(intake.length === 0 ? [] : [`Not yet triaged, sent to intake first: ${intake.join(', ')}.`]),
    ...declared.unresolved.map(part => `Not in the order: "${part.named}": ${part.why}`),
  ];
  emit({ summary: lines.join('\n') });
}

try {
  main();
} catch (error) {
  refuse(`build-queue order: ${error instanceof Error ? error.message : String(error)}`);
}
