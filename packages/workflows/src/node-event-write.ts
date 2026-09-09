import type { WorkflowDeps } from './deps';

import type { NodeStateEventInput } from './store';

/** Storage rejection must leave node retry policy and reach the run failure boundary. */
export class NodeEventWriteError extends Error {
  constructor(event: NodeStateEventInput, cause: unknown) {
    const originalFailure = event.event_type === 'node_failed' ? event.data?.error : undefined;
    super(
      `Could not persist ${event.event_type} for ${event.step_name ?? 'unknown node'}: ${cause instanceof Error ? cause.message : String(cause)}${typeof originalFailure === 'string' ? `; original node failure: ${originalFailure}` : ''}`,
      { cause }
    );
    this.name = 'NodeEventWriteError';
  }
}

export async function persistNodeEvent(
  store: WorkflowDeps['store'],
  event: NodeStateEventInput
): Promise<void> {
  try {
    await store.persistWorkflowEvent(event);
  } catch (error) {
    throw new NodeEventWriteError(event, error);
  }
}
