/**
 * The rule a pack's bindings follow wherever the pack is read: a binding may name only a
 * workflow the pack's `archon-plugin.json` lists as an entrypoint, refused with one message.
 * `archon pack bindings` and `archon validate workflows` both read it here.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import * as archonPaths from '@archon/paths';
import { PLUGIN_MANIFEST_FILE, workflowPackManifestSchema } from '@archon/plugin-manifest';
import { bindingWorkflowNames, declaringPack, packWorkflowName } from './pack-graph';
import { loadPackDeclaration, PackSettingsError } from './pack-settings';
import type { PackBinding } from './schemas/pack-bindings';
import type { WorkflowWithSource } from './schemas/workflow';
import { packDirectory, type WorkflowSourceRoots } from './workflow-source';
import { readScopePacks } from './workflow-discovery/pack-layout';

/**
 * A pack's bindings and the names they may name, both from the copy that declares the
 * bindings: the entrypoints its directory's `archon-plugin.json` lists, or every stage of the
 * pack when there is no workflow-pack manifest. Discovery reads a pack folder's every
 * workflow while an installed copy holds only its entrypoints, so this is what makes a folder
 * refuse what an installed copy refuses. An entrypoint whose manifest key differs from its
 * YAML `name:` is not found from a folder. Undefined when no copy declares bindings; throws
 * when the manifest cannot be read.
 */
export async function packBindingScope(
  roots: WorkflowSourceRoots,
  workflows: readonly WorkflowWithSource[]
): Promise<{ bindings: Readonly<Record<string, PackBinding>>; names: string[] } | undefined> {
  const pack = declaringPack(workflows);
  if (pack?.bindings === undefined) return undefined;
  const all = workflows.map(entry => entry.workflow.name);
  const dir = await packDirectory(roots, pack);
  const manifest = dir === null ? undefined : await readPackManifest(dir);
  const names =
    manifest === undefined
      ? all
      : manifest.entrypoints.flatMap(key => packWorkflowName(all, key) ?? []);
  return { bindings: pack.bindings, names };
}

/**
 * The name and entrypoint keys of the workflow-pack `archon-plugin.json` in `dir`, or
 * undefined when it holds none (or another kind's). Throws when it cannot be read.
 */
async function readPackManifest(
  dir: string
): Promise<{ name: string; entrypoints: string[] } | undefined> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf-8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || raw.kind !== 'workflow-pack')
    return undefined;
  const { name, entrypoints } = workflowPackManifestSchema.parse(raw);
  return { name, entrypoints: Object.keys(entrypoints) };
}

/**
 * The pack directories a project or source `root` holds, as discovery reads them: `root`
 * itself, when it is a pack folder, and each pack under its workflow folder, keyed by its
 * folder name.
 */
export async function rootPackDirs(root: string): Promise<{ dir: string; key?: string }[]> {
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const { packs } = await readScopePacks(join(root, workflowFolder));
  return [{ dir: root }, ...packs.map(pack => ({ dir: pack.path, key: pack.name }))];
}

/**
 * The refusals of the bindings `dir`'s `.pack/pack.yaml` declares to a workflow its
 * workflow-pack manifest does not list as an entrypoint, under `key` or the manifest name.
 * Undefined when `dir` has no workflow-pack manifest or no valid declaration (an invalid one
 * is a load error of every workflow of the pack). Whether a listed workflow loaded is not
 * this rule's business. Throws when the manifest cannot be read.
 */
export async function manifestBindingRefusals(
  dir: string,
  key?: string
): Promise<{ key: string; refusals: string[] } | undefined> {
  const manifest = await readPackManifest(dir);
  if (manifest === undefined) return undefined;
  let bindings: Readonly<Record<string, PackBinding>>;
  try {
    bindings = (await loadPackDeclaration(dir, '.')).bindings ?? {};
  } catch (error) {
    if (error instanceof PackSettingsError) return undefined;
    throw error;
  }
  const packKey = key ?? manifest.name;
  return { key: packKey, refusals: packBindingRefusals(packKey, bindings, manifest.entrypoints) };
}

/** The refusal of each workflow `bindings` name that `names`, what the pack lets them bind, lacks. */
function packBindingRefusals(
  packKey: string,
  bindings: Readonly<Record<string, PackBinding>>,
  names: readonly string[]
): string[] {
  return Object.entries(bindings).flatMap(([id, binding]) =>
    bindingWorkflowNames(binding)
      .filter(declared => packWorkflowName(names, declared) === undefined)
      .map(declared => packBindingWorkflowMissing(packKey, id, declared))
  );
}

/** The refusal of a binding that names a workflow its pack does not let it bind. */
export function packBindingWorkflowMissing(packKey: string, id: string, declared: string): string {
  return `Binding '${id}' names workflow '${declared}', which pack '${packKey}' does not provide.`;
}
