/**
 * The pack a run's workflow came from, as the item read reports it on each run.
 */
import { z } from 'zod';
import { readRunDispatchMetadata } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';

/**
 * `key` is the pack key the run recorded at dispatch, as `.archon/packs/<key>.yaml` names
 * it: the folder name for a pack in the project, `owner.plugin` for an installed one.
 * `workflow` is the workflow's authored `name:`, as the pack's own files and bindings name
 * it, so a project copy and an installed copy of the same pack read the same value.
 * `workflow` alone is local to a pack: another pack may have a workflow of the same name.
 */
export const runPackSchema = z.object({ key: z.string(), workflow: z.string() });
export type RunPack = z.infer<typeof runPackSchema>;

/**
 * Read from what the run recorded at dispatch, never recovered from its public name: an
 * installed entrypoint may publish a workflow under a name other than its `name:`. Null for
 * a run that recorded no pack, or recorded one without the name (older builds).
 */
export function runPack(run: Pick<WorkflowRun, 'metadata'>): RunPack | null {
  const key = runPackKey(run);
  const workflow = readRunDispatchMetadata(run.metadata)?.pack_workflow;
  return key === null || workflow === undefined ? null : { key, workflow };
}

/**
 * The pack key alone, read as `runPack` reads it. Older builds recorded the key without the
 * workflow's name, so this is non-null on runs `runPack` reads as null.
 */
export function runPackKey(run: Pick<WorkflowRun, 'metadata'>): string | null {
  return readRunDispatchMetadata(run.metadata)?.pack ?? null;
}
