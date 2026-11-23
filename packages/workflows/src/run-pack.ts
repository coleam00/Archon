/**
 * The pack a run's workflow came from, as the item read reports it on each run.
 */
import { z } from 'zod';
import { readRunDispatchMetadata } from './schemas/run-metadata';
import type { WorkflowRun } from './schemas/workflow-run';
import { nameWithinInstalledPack } from './workflow-source/installed-packs';

/**
 * `key` is the pack key the run recorded at dispatch, as `.archon/packs/<key>.yaml` names
 * it: the folder name for a pack in the project, `owner.plugin` for an installed one.
 * `workflow` is the workflow's name within its pack, as the pack's own files and bindings
 * name it, so a project copy and an installed copy of the same pack read the same value.
 */
export const runPackSchema = z.object({ key: z.string(), workflow: z.string() });
export type RunPack = z.infer<typeof runPackSchema>;

/**
 * Read from the pack key the run recorded at dispatch, not from its name alone: a workflow
 * name may itself hold a `:`. The recorded `source` is not consulted because a dispatch
 * need not record one; the installed prefix is matched against the recorded key instead.
 * Null for a run that recorded no pack.
 */
export function runPack(run: Pick<WorkflowRun, 'metadata' | 'workflow_name'>): RunPack | null {
  const key = readRunDispatchMetadata(run.metadata)?.pack;
  if (key === undefined) return null;
  return { key, workflow: nameWithinInstalledPack(key, run.workflow_name) ?? run.workflow_name };
}
