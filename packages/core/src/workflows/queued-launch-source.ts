import { rm } from 'node:fs/promises';
import { readWorkflowSourceState } from '@archon/workflows/schemas/workflow-run';

/**
 * Remove the source a queued start's launch captured, once its request no longer runs it:
 * `trigger withdraw`, or a start a host drain took from its queue to prepare again. A
 * launch that captured none leaves nothing. Throws when its source record does not read:
 * what to remove cannot be known, so storage needs inspecting.
 */
export async function releaseQueuedLaunchSource(launch: {
  run: { metadata?: Record<string, unknown> };
}): Promise<void> {
  const source = readWorkflowSourceState(launch.run.metadata);
  if (source.kind === 'recorded') await rm(source.record.root, { recursive: true, force: true });
  if (source.kind === 'unreadable')
    throw new Error(
      `its source record is unreadable (${source.detail}); inspect storage before cleanup.`
    );
}
