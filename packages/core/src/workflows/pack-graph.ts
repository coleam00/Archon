/**
 * The stage graph of one pack as this install has it (`buildPackGraph`), read for the
 * project at `cwd`: the pack's workflows discovered from there, its declared bindings, and
 * the run-ended trigger files whose binding launches in that project. The CLI's
 * `archon pack graph` and `GET /api/packs/{pack}/graph` both read it here.
 */
import { loadStoreSelection } from '../config/store-selection';
import type { WorkflowDeps } from '@archon/workflows/deps';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import {
  buildPackGraph,
  nearestPackBindings,
  packWorkflows,
  type InstalledArrow,
  type PackGraph,
} from '@archon/workflows/pack-graph';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  bindingProjectKey,
  readRunEndedBindings,
  type RunEndedStartsDependencies,
} from './run-ended';

export async function readPackGraph(
  cwd: string,
  packKey: string,
  deps: Pick<WorkflowDeps, 'loadConfig' | 'providers'> &
    Pick<RunEndedStartsDependencies, 'triggersDirectory' | 'projectKeyOf'>
): Promise<PackGraph> {
  const discovered = await discoverWorkflowsWithConfig(cwd, deps.loadConfig, deps.providers);
  const workflows = packWorkflows(discovered, packKey, cwd);
  const stages = workflows.map(entry => entry.workflow);
  const names = new Set(stages.map(stage => stage.name));

  const files = await readRunEndedBindings(deps.triggersDirectory());
  const installed: InstalledArrow[] = [];
  if (files.length > 0) {
    // The file store has no items, so a run-ended binding can never start anything there.
    if ((await loadStoreSelection()) === 'files')
      throw new FileStoreUnsupportedError(
        `Run-ended triggers (${files.map(entry => entry.file).join(', ')})`
      );
    // A path no project is registered at yet is a project of its own, as `trigger check`
    // counts it.
    const project = (await deps.projectKeyOf(cwd)) ?? cwd;
    for (const file of files) {
      const launchWorkflow = file.binding.launch.workflowName;
      if (!names.has(file.runEnded.workflowName) && !names.has(launchWorkflow)) continue;
      const launches = (await bindingProjectKey(file, deps)) ?? file.binding.launch.cwd;
      if (launches !== project) continue;
      installed.push({
        file: file.file,
        sourceInstanceId: file.sourceInstanceId,
        runEnded: file.runEnded,
        launchWorkflow,
      });
    }
  }
  return buildPackGraph({
    packKey,
    stages,
    declared: nearestPackBindings(workflows),
    installed,
  });
}
