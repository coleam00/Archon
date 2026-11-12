import { isDeepStrictEqual } from 'node:util';
import type { PreparedWorkflowLaunch, ResourceStartIntent } from './schemas/resource-start';
import type { ResourceStartRequestInspection } from './resource-start-store';
import type { WorkflowRun } from './schemas/workflow-run';

/** Attachment must preserve the native row's provenance and invocation. */
export function validatePendingResourceRun(
  run: WorkflowRun | null,
  launch: PreparedWorkflowLaunch
): asserts run is WorkflowRun {
  if (!run || run.status !== 'pending')
    throw new Error(`Resource start '${launch.run.id}' requires an existing pending run`);
  const expected = launch.run;
  if (
    run.id !== expected.id ||
    run.workflow_name !== expected.workflow_name ||
    run.codebase_id !== expected.codebase_id ||
    run.user_message !== expected.user_message ||
    !isDeepStrictEqual(run.origin, expected.origin ?? null) ||
    Object.entries(expected.metadata).some(
      ([key, value]) => !isDeepStrictEqual(run.metadata[key], value)
    )
  )
    throw new Error(`Resource start '${expected.id}' does not identify its pending invocation`);
}

export function validatePendingStartReplay(
  request: Pick<
    ResourceStartRequestInspection,
    'resource' | 'hostId' | 'overlap' | 'declaredCapacity' | 'launch'
  >,
  intent: ResourceStartIntent
): void {
  if (
    request.resource !== intent.resource ||
    request.hostId !== intent.hostId ||
    request.overlap !== intent.overlap ||
    request.declaredCapacity !== intent.capacity ||
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(request.launch)),
      JSON.parse(JSON.stringify(intent.launch))
    )
  )
    throw new Error(
      `Resource start '${intent.launch.run.id}' does not identify its retained request`
    );
}
