/**
 * What a command says about the pack copy it read: `pack graph`, `pack bindings` and a run
 * start name which copy of the pack they loaded, from where, and how to choose another copy
 * of the same pack. The refusals under `--workflow-source` use `describeWorkflowSource` to
 * name what the source directory was read as.
 */
import { join, resolve } from 'node:path';
import { packCopies, type PackCopy } from '@archon/workflows/pack-graph';
import type { ResolvedWorkflow, WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import {
  installedWorkflowName,
  liveSourceRoots,
  sourcePackFolder,
  splitInstalledPackKey,
} from '@archon/workflows/workflow-source';

/** A copy as `<dir> (<scope>)`; `source` is the directory discovery read from. */
function describeCopy(copy: PackCopy, source: string): string {
  const dir = copy.dir ?? "this build's embedded bundled packs";
  const scope =
    copy.source === 'project' && copy.dir === resolve(source)
      ? 'project, the source directory is the pack folder'
      : copy.source;
  return `${dir} (${scope})`;
}

export function loadedLine(packKey: string, copy: PackCopy, source: string): string {
  return `Pack '${packKey}' loaded from ${describeCopy(copy, source)}.`;
}

export function otherCopyLine(copy: PackCopy, source: string): string {
  return `Another copy is in reach: '${copy.key}' at ${describeCopy(copy, source)}.`;
}

/**
 * The lines naming the copy of `workflow`'s pack this run loaded and the other copies in
 * reach. Paths are the live origin (`sourceRoot` read live), not the run's capture, which
 * moves after start. Empty for a workflow outside a pack.
 */
export async function packCopyLines(
  workflow: ResolvedWorkflow,
  entries: readonly WorkflowWithSource[],
  sourceRoot: string,
  explicitSource: boolean
): Promise<string[]> {
  const pack = workflow.pack;
  if (pack === undefined) return [];
  const { loaded, otherCopies } = await packCopies(
    { workflows: [...entries], errors: [] },
    liveSourceRoots(sourceRoot),
    pack.key
  );
  const own = loaded.find(copy => copy.source === pack.source);
  return [
    ...(own ? [loadedLine(pack.key, own, sourceRoot)] : []),
    ...otherCopies.map(
      copy =>
        `${otherCopyLine(copy, sourceRoot)} ${howToRun(copy, workflow, entries, explicitSource)}`
    ),
  ];
}

/**
 * How to run the other copy. An installed workflow is refused under `--workflow-source`,
 * so its hint drops the flag.
 */
function howToRun(
  copy: PackCopy,
  workflow: ResolvedWorkflow,
  entries: readonly WorkflowWithSource[],
  explicitSource: boolean
): string {
  const names = entries
    .filter(e => e.source === copy.source && e.workflow.pack?.key === copy.key)
    .map(e => e.workflow.name);
  const entry = entryName(workflow);
  if (copy.source === 'installed') {
    const owner = splitInstalledPackKey(copy.key);
    if (owner === null) return '';
    const qualified = installedWorkflowName(owner, entry);
    const drop = explicitSource ? 'drop --workflow-source and ' : '';
    return names.includes(qualified)
      ? `To run it, ${drop}name '${qualified}'.`
      : `It has no workflow '${qualified}'; to see its workflows, ${drop}run 'archon workflow list'.`;
  }
  if (names.includes(entry)) return `To run it, name '${entry}'.`;
  return names.length > 0 ? `Its workflows include '${names[0]}'.` : '';
}

/**
 * The workflow's name within its pack: an installed workflow is named
 * `<owner>/<pack>:<entry>` (`installedWorkflowName`), every other one by its own name.
 */
function entryName(workflow: ResolvedWorkflow): string {
  const pack = workflow.pack;
  const owner = pack?.source === 'installed' ? splitInstalledPackKey(pack.key) : null;
  if (owner === null) return workflow.name;
  const prefix = installedWorkflowName(owner, '');
  return workflow.name.startsWith(prefix) ? workflow.name.slice(prefix.length) : workflow.name;
}

/**
 * What `--workflow-source <root>` was read as, for a refusal: a pack folder names the pack
 * and its workflows, any other directory the workflow folder Archon looked in.
 */
export async function describeWorkflowSource(
  root: string,
  entries: readonly WorkflowWithSource[]
): Promise<string> {
  let pack: Awaited<ReturnType<typeof sourcePackFolder>>;
  try {
    pack = await sourcePackFolder(root);
  } catch (error) {
    return `Archon could not read it as a pack folder: ${(error as Error).message}`;
  }
  if (pack === null) return `Archon looked in ${join(root, '.archon', 'workflows')}`;
  const names = entries
    .filter(e => e.source === 'project' && e.workflow.pack?.key === pack.name)
    .map(e => `'${e.workflow.name}'`);
  return (
    `this source is the folder of pack '${pack.name}', whose workflows are named ` +
    (names.length > 0 ? names.join(', ') : '(none loaded)')
  );
}
