/**
 * The stage graph of one pack as this install has it (`buildPackGraph`), read for the
 * project at `cwd`: the pack's workflows discovered from there (or from `workflowSource`,
 * as a binding's `launch.discoveryCwd` discovers them), its declared bindings, and the
 * run-ended trigger files whose binding launches in that project, each checked as a run
 * is checked before it starts. The CLI's `archon pack graph` and
 * `GET /api/packs/{pack}/graph` both read it here.
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
  runEndedBindingCheck,
  type RunEndedStartsDependencies,
} from './run-ended';

type GraphDeps = Pick<WorkflowDeps, 'loadConfig' | 'providers'> &
  Pick<RunEndedStartsDependencies, 'triggersDirectory' | 'projectKeyOf'>;

/** The run-ended files that touch a stage and launch in the project of `cwd`, each checked. */
async function installedArrows(
  cwd: string,
  stageNames: ReadonlySet<string>,
  deps: GraphDeps
): Promise<InstalledArrow[]> {
  const files = await readRunEndedBindings(deps.triggersDirectory());
  if (files.length === 0) return [];
  // The file store has no items, so a run-ended binding can never start anything there.
  if ((await loadStoreSelection()) === 'files')
    throw new FileStoreUnsupportedError(
      `Run-ended triggers (${files.map(entry => entry.file).join(', ')})`
    );
  // A path no project is registered at yet is a project of its own, as `trigger check`
  // counts it.
  const project = (await deps.projectKeyOf(cwd)) ?? cwd;
  const installed: InstalledArrow[] = [];
  for (const file of files) {
    const launchWorkflow = file.binding.launch.workflowName;
    if (!stageNames.has(file.runEnded.workflowName) && !stageNames.has(launchWorkflow)) continue;
    const launches = (await bindingProjectKey(file, deps)) ?? file.binding.launch.cwd;
    if (launches !== project) continue;
    installed.push({
      file: file.file,
      sourceInstanceId: file.sourceInstanceId,
      runEnded: file.runEnded,
      launchWorkflow,
      // The preflight check: a binding it refuses fails every item run of its ended stage.
      problems: await runEndedBindingCheck(file, deps),
    });
  }
  return installed;
}

export async function readPackGraph(
  cwd: string,
  packKey: string,
  deps: GraphDeps,
  options: { workflowSource?: string } = {}
): Promise<PackGraph> {
  const source = options.workflowSource ?? cwd;
  const discovered = await discoverWorkflowsWithConfig(source, deps.loadConfig, deps.providers);
  const workflows = packWorkflows(discovered, packKey, source);
  const stages = workflows.map(entry => entry.workflow);
  return buildPackGraph({
    packKey,
    stages,
    declared: nearestPackBindings(workflows),
    installed: await installedArrows(cwd, new Set(stages.map(stage => stage.name)), deps),
    workflows: [...discovered.workflows, ...(discovered.support ?? [])].map(e => e.workflow),
    discoveryErrors: discovered.errors,
  });
}
