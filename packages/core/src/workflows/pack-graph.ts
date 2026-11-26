/**
 * The stage graph of one pack as this install has it (`buildPackGraph`), read for the
 * project at `cwd`: the pack's workflows discovered from there (or from `workflowSource`,
 * as a binding's `launch.discoveryCwd` discovers them), which copy of the pack that was
 * and the other copies in reach (`packCopies`), its declared bindings, and the
 * run-ended and asks-settled trigger files whose binding launches in that project, each
 * checked as a run is checked before it starts. The CLI's `archon pack graph` and
 * `GET /api/packs/{pack}/graph` both read it here.
 */
import { loadStoreSelection } from '../config/store-selection';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  PackSettingsError,
  projectPackSettingsPath,
  readProjectPackSettings,
  validateProjectPackSettings,
} from '@archon/workflows/pack-settings';
import { loadPackMetricViews } from '@archon/workflows/metric-views';
import { groupProblems, loadPackDocument } from '@archon/workflows/pack-document';
import {
  buildPackGraph,
  graphLink,
  nearestPackBindings,
  packCopies,
  packWorkflowIdentities,
  packWorkflows,
  type InstalledArrow,
  type PackGraph,
} from '@archon/workflows/pack-graph';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { liveSourceRoots } from '@archon/workflows/workflow-source';
import { asksSettledBindingCheck } from './asks-settled';
import type { BindingDefinitionsDeps } from './definition-source';
import {
  bindingProjectKey,
  readOnBindings,
  runEndedBindingCheck,
  type OnBinding,
  type RunEndedStartsDependencies,
} from './run-ended';

type GraphDeps = BindingDefinitionsDeps &
  Pick<RunEndedStartsDependencies, 'triggersDirectory' | 'projectKeyOf'> & {
    /**
     * The recorded capacity and the runs holding a slot of each resource named. A reader
     * without it reports no limit and nothing held.
     */
    slotOccupancy?: (
      resources: readonly string[]
    ) => Promise<ReadonlyMap<string, { capacity: number; held: number }>>;
  };

/** Each resource the registered arrows start work on, with its stages, limit and slots held. */
async function packCapacity(
  installed: readonly InstalledArrow[],
  deps: GraphDeps
): Promise<PackGraph['capacity']> {
  const resources = [...new Set(installed.map(arrow => arrow.resource))];
  const slots = (await deps.slotOccupancy?.(resources)) ?? new Map<string, never>();
  return resources.map(resource => {
    const arrows = installed.filter(arrow => arrow.resource === resource);
    return {
      resource,
      stages: [...new Set(arrows.map(arrow => arrow.launchWorkflow))],
      declared: arrows.find(arrow => arrow.capacity !== null)?.capacity ?? null,
      limit: slots.get(resource)?.capacity ?? null,
      held: slots.get(resource)?.held ?? 0,
    };
  });
}

/** The link a run-ended file starts its stage over, or null for a same-item start. */
function installedLink(file: OnBinding): InstalledArrow['linked'] {
  return 'runEnded' in file ? graphLink(file.runEnded.linked, file.runEnded.inputs) : null;
}

/** Where an installed file's arrow starts, as the file spells it. */

function installedFrom(file: OnBinding): InstalledArrow['from'] {
  return 'runEnded' in file
    ? { stage: file.runEnded.workflowName, outcome: file.runEnded.outcome }
    : {
        stage: file.asksSettled.workflowName,
        settled: file.asksSettled.settled,
        ...(file.asksSettled.option === undefined ? {} : { option: file.asksSettled.option }),
      };
}

/**
 * The run-ended and asks-settled files that touch the pack and launch in the project of `cwd`, each with
 * what keeps the engine from starting it. `touches` says whether a workflow name is one of
 * the pack's: a stage, or a name its declared bindings use, so a file about a stage that
 * failed to load still shows.
 */
async function installedArrows(
  cwd: string,
  touches: (workflowName: string) => boolean,
  deps: GraphDeps
): Promise<InstalledArrow[]> {
  const files = await readOnBindings(deps.triggersDirectory());
  if (files.length === 0) return [];
  // The file store has no items, so a binding with `on` can never start anything there.
  if ((await loadStoreSelection()) === 'files')
    throw new FileStoreUnsupportedError(
      `Run-ended and asks-settled triggers (${files.map(entry => entry.file).join(', ')})`
    );
  // A path no project is registered at yet is a project of its own, as `trigger check`
  // counts it.
  const project = (await deps.projectKeyOf(cwd)) ?? cwd;
  const installed: InstalledArrow[] = [];
  for (const file of files) {
    const launchWorkflow = file.binding.launch.workflowName;
    const from = installedFrom(file);
    if (!touches(from.stage) && !touches(launchWorkflow)) continue;
    const entry = {
      file: file.file,
      sourceInstanceId: file.sourceInstanceId,
      resource: file.binding.resource,
      capacity: file.binding.capacity ?? null,
      from,
      launchWorkflow,
      linked: installedLink(file),
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
    // The preflight check: a binding it refuses fails every item run of its source stage.
    const problems =
      'runEnded' in file
        ? await runEndedBindingCheck(file, deps)
        : await asksSettledBindingCheck(file, deps);
    installed.push({ ...entry, problems });
  }
  return installed;
}

/**
 * The values the project sets, or none when its settings file does not read; that error is
 * among the settings file's problems. A setting naming a missing file still shows its value.
 */
async function projectValues(
  cwd: string,
  pack: Parameters<typeof readProjectPackSettings>[1]
): Promise<Record<string, string>> {
  try {
    return await readProjectPackSettings(cwd, pack);
  } catch (error) {
    if (error instanceof PackSettingsError) return {};
    throw error;
  }
}

/** The pack's declared settings with the project's values, and its settings file. */
async function packSettings(
  cwd: string,
  packKey: string,
  workflows: ReturnType<typeof packWorkflows>
): Promise<Pick<PackGraph, 'settings' | 'settingsFile'>> {
  // Every workflow of a pack carries its declaration, and the nearest scope's wins.
  const own = workflows.filter(entry => entry.workflow.pack?.key === packKey);
  const pack = own[0]?.workflow.pack;
  // A missing `file` setting is checked through the inputs of each workflow that reads it.
  const problems = [
    ...new Set(
      (await Promise.all(own.map(entry => validateProjectPackSettings(cwd, entry.workflow)))).flat()
    ),
  ];
  const values = pack === undefined ? {} : await projectValues(cwd, pack);
  return {
    settings: Object.entries(pack?.settings ?? {}).map(([name, spec]) => ({
      name,
      description: spec.description ?? null,
      type: spec.type,
      default: spec.default ?? null,
      value: values[name] ?? null,
    })),
    settingsFile: { path: relative(cwd, projectPackSettingsPath(cwd, packKey)), problems },
  };
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
  const copies = await packCopies(discovered, liveSourceRoots(source), packKey);
  const installed = await installedArrows(cwd, touches, deps);
  const graph = buildPackGraph({
    packKey,
    stages,
    declared,
    installed,
    workflows: [...discovered.workflows, ...(discovered.support ?? [])].map(e => e.workflow),
    discoveryErrors: discovered.errors,
  });
  // The nearest copy's document, as the nearest copy's bindings are the pack's.
  const dir = copies.loaded[0]?.dir ?? null;
  const read = dir === null ? null : await loadPackDocument(dir);
  const views = dir === null ? null : await loadPackMetricViews(dir);
  const problems =
    read === null
      ? []
      : [
          ...read.problems,
          ...groupProblems(
            read.groups,
            graph.stages.filter(stage => stage.inFlow).map(stage => stage.workflow)
          ),
        ];
  return {
    ...graph,
    ...copies,
    document:
      read === null || read.document === null
        ? null
        : { path: read.document, problems, text: read.text },
    metricViews: views === null ? null : { names: {}, cards: [], problem: null, ...views },
    groups: read === null || problems.length > 0 ? [] : read.groups,
    ...(await packSettings(cwd, packKey, workflows)),
    capacity: await packCapacity(installed, deps),
  };
}
