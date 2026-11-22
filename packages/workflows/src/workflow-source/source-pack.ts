import { readFile } from 'fs/promises';
import { join } from 'path';
import * as archonPaths from '@archon/paths';
import {
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { isDirectory } from './tree';

/**
 * A pack's own folder given as the workflow source: the folder whose root holds a
 * workflow-pack `archon-plugin.json`. It is read as one project-scope pack keyed by its
 * manifest `name`, exactly as if it sat at `<source>/.archon/workflows/<name>/`, so a pack
 * author can run the pack without installing it or copying it into that layout.
 */
export interface SourcePackFolder {
  /** The manifest `name`: the pack's key in the project scope. */
  readonly name: string;
  /** The folder itself, holding `archon-plugin.json`. */
  readonly dir: string;
}

/** A pack folder that also holds `.archon/workflows/<name>/`: two copies of one pack. */
export class AmbiguousSourcePackError extends Error {
  constructor(
    readonly packName: string,
    manifestFile: string,
    nested: string
  ) {
    super(
      `${manifestFile} makes this source pack '${packName}', and it also holds a copy of that ` +
        `pack at ${nested}. Neither copy is loaded. Remove one, or point at a directory that holds only one.`
    );
    this.name = 'AmbiguousSourcePackError';
  }
}

/**
 * The pack folder `dir` is, or null when its root has no plugin manifest or the manifest
 * is not a workflow pack. Every reader that maps a project source to its packs (live
 * discovery, script discovery, `packDirectory`, the run capture) asks this, so they
 * cannot disagree about what a pack folder is.
 *
 * Throws on an unreadable or invalid workflow-pack manifest, and when the folder also
 * holds `.archon/workflows/<name>/`: two copies of one pack in one source is ambiguous,
 * and picking one would run bytes the author did not choose.
 */
export async function sourcePackFolder(dir: string): Promise<SourcePackFolder | null> {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`, { cause: error });
  }
  // A provider or forge plugin checkout is not a pack; its source reads as before.
  if (typeof raw !== 'object' || raw === null || !('kind' in raw) || raw.kind !== 'workflow-pack')
    return null;
  const parsed = workflowPackManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${file}: ${describeIssues(parsed.error)}`);
  const { name } = parsed.data;
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const nested = join(dir, workflowFolder, name);
  if (await isDirectory(nested)) throw new AmbiguousSourcePackError(name, file, nested);
  return { name, dir };
}
