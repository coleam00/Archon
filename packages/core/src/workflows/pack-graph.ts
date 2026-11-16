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
import { existsSync } from 'node:fs';
import {
  buildPackGraph,
  nearestPackBindings,
  packWorkflowIdentities,
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

/**
 * The run-ended files that touch the pack and launch in the project of `cwd`, each with
 * what keeps the engine from starting it. `touches` says whether a workflow name is one of
 * the pack's: a stage, or a name its declared bindings use, so a file about a stage that
 * failed to load still shows.
 */
async function installedArrows(
  cwd: string,
  touches: (workflowName: string) => boolean,
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
    if (!touches(file.runEnded.workflowName) && !touches(launchWorkflow)) continue;
    const entry = {
      file: file.file,
      sourceInstanceId: file.sourceInstanceId,
      runEnded: file.runEnded,
      launchWorkflow,
    };
    // A start from a missing checkout is in no project, so the end of a run never starts
    // it (`launchProjectKey`). Which project it was meant for cannot be known, so a file
    // about this pack is shown with the problem `trigger check` gives it, not hidden.
    if (!existsSync(file.binding.launch.cwd)) {
      installed.push({
        ...entry,
        problems: [
          `binding.launch.cwd '${file.binding.launch.cwd}' does not exist, so this binding never starts; fix the path or remove the file`,
        ],
      });
      continue;
    }
    const launches = (await bindingProjectKey(file, deps)) ?? file.binding.launch.cwd;
    if (launches !== project) continue;
    // The preflight check: a binding it refuses fails every item run of its ended stage.
    installed.push({ ...entry, problems: await runEndedBindingCheck(file, deps) });
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
  const declared = nearestPackBindings(workflows);
  const own = packWorkflowIdentities(
    stages.map(stage => stage.name),
    declared
  );
  const touches = (name: string): boolean => own.has(name);
  return buildPackGraph({
    packKey,
    stages,
    declared,
    installed: await installedArrows(cwd, touches, deps),
    workflows: [...discovered.workflows, ...(discovered.support ?? [])].map(e => e.workflow),
    discoveryErrors: discovered.errors,
  });
}
