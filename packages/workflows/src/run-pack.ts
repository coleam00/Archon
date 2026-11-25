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
  const dispatch = readRunDispatchMetadata(run.metadata);
  if (dispatch?.pack === undefined || dispatch.pack_workflow === undefined) return null;
  return { key: dispatch.pack, workflow: dispatch.pack_workflow };
}
