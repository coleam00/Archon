/**
 * The packaged-workflow layout, `<root>/<pack>/<workflow>/<file>.yaml`: which packs a
 * workflows root holds, and what each workflow folder of a pack holds (a workflow,
 * no YAML, or a load error). Discovery, the server's by-name lookup and the bundle
 * inventory all read the tree through this module so they cannot disagree about it.
 * Nothing here parses: each reader reads and parses the located file on its own terms.
 */
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type { WorkflowLoadError } from '../schemas';
import { isValidWorkflowFolderSegment } from '../packaged-workflow';
import { FIXTURES_DIR } from '../fixture-layout';
import { getLog } from './log';

export function isYamlFile(entry: string): boolean {
  return entry.endsWith('.yaml') || entry.endsWith('.yml');
}

/** A filesystem failure as a load error: `<operation> error: <message> (<code>)`. */
export function fileSystemError(
  filename: string,
  operation: 'Directory read' | 'File read' | 'Path read',
  error: unknown
): WorkflowLoadError {
  const err = error as NodeJS.ErrnoException;
  return {
    filename,
    error: `${operation} error: ${err.message} (${err.code ?? 'unknown'})`,
    errorType: 'read_error',
    cause: error,
  };
}

/** A load error as a thrown `Error`, for a reader that fails instead of listing it. */
export function loadErrorToError({ error, cause }: WorkflowLoadError): Error {
  return new Error(error, { cause });
}

/** A failed `stat` of a packaged path: a vanished path is skipped, anything else reported. */
export function pathReadError(
  filename: string,
  logContext: Record<string, string>,
  error: unknown
): WorkflowLoadError | undefined {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') return undefined;
  getLog().warn({ err, ...logContext }, 'packaged_workflow_path_read_error');
  return fileSystemError(filename, 'Path read', error);
}

/** One pack directory of a scope's workflows root. */
export interface ScopePack {
  readonly name: string;
  readonly path: string;
}

/** A workflow folder holding exactly one YAML file: the packaged workflow. */
export interface PackWorkflowLocation {
  readonly kind: 'workflow';
  readonly folder: string;
  /** The workflow folder's directory. */
  readonly path: string;
  /** Its one YAML file. */
  readonly filename: string;
}

/** What one `<workflow>/` folder of a pack holds. */
export type PackWorkflowFolder =
  | PackWorkflowLocation
  /** No YAML (tests, docs, assets): no workflow. Discovery skips it; the bundle inventory rejects it. */
  | { readonly kind: 'empty'; readonly folder: string }
  | {
      readonly kind: 'error';
      readonly folder: string;
      readonly error: WorkflowLoadError;
      /** The folder's YAML files, sorted; empty when it could not be read. A by-name lookup matches on their stems. */
      readonly yamlFiles: readonly string[];
    };

export type PackListing =
  | { readonly folders: PackWorkflowFolder[] }
  | { readonly error: WorkflowLoadError };

function sorted(entries: string[]): string[] {
  return entries.sort((a, b) => a.localeCompare(b));
}

/** The packs of a workflows root. A missing root holds none. */
export async function readScopePacks(
  workflowsRoot: string
): Promise<{ packs: ScopePack[]; errors: WorkflowLoadError[] }> {
  const packs: ScopePack[] = [];
  const errors: WorkflowLoadError[] = [];
  let entries: string[];
  try {
    entries = await readdir(workflowsRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { packs, errors };
    getLog().warn({ err, workflowsRoot }, 'packaged_workflow_directory_read_error');
    return { packs, errors: [fileSystemError(workflowsRoot, 'Directory read', error)] };
  }

  for (const name of sorted(entries)) {
    const path = join(workflowsRoot, name);
    const read = await readScopePack(name, path);
    if (read === 'pack') packs.push({ name, path });
    else if (read !== undefined) errors.push(read);
  }
  return { packs, errors };
}

async function readScopePack(
  name: string,
  packPath: string
): Promise<'pack' | WorkflowLoadError | undefined> {
  try {
    if (!(await stat(packPath)).isDirectory()) return undefined;
  } catch (error) {
    return pathReadError(name, { packPath }, error);
  }
  // `defaults` is the flat-defaults convention, not a pack: loadWorkflowsFromDir
  // reads its files. Captures taken by builds that still bundled flat defaults
  // hold `defaults/legacy/`, which packaged scanning would misread and fail with
  // "must contain exactly one .yaml" on every discovery pass.
  if (name === 'defaults' || name === FIXTURES_DIR) return undefined;
  if (!isValidWorkflowFolderSegment(name)) {
    return {
      filename: name,
      error: `Invalid packaged workflow pack directory '${name}'.`,
      errorType: 'validation_error',
    };
  }
  return 'pack';
}

/** The workflow folders of one pack directory, in sorted order; `label` names the pack in errors. */
export async function readPackWorkflowFolders(
  packPath: string,
  label: string
): Promise<PackListing> {
  let entries: string[];
  try {
    entries = await readdir(packPath);
  } catch (error) {
    return { error: fileSystemError(label, 'Directory read', error) };
  }
  const folders: PackWorkflowFolder[] = [];
  for (const folder of sorted(entries)) {
    // A dot directory (`.shared`, `.github`, ...) is never a workflow folder: a workflow
    // folder name cannot start with a dot. A pack installed from a repository root
    // carries that repository's other directories, so these are expected, not errors.
    if (folder.startsWith('.') || folder === FIXTURES_DIR) continue;
    const read = await readPackWorkflowFolder(join(packPath, folder), `${label}/${folder}`, folder);
    if (read !== undefined) folders.push(read);
  }
  return { folders };
}

async function readPackWorkflowFolder(
  path: string,
  folderLabel: string,
  folder: string
): Promise<PackWorkflowFolder | undefined> {
  try {
    if (!(await stat(path)).isDirectory()) return undefined;
  } catch (error) {
    const pathError = pathReadError(folderLabel, { workflowPath: path }, error);
    return pathError && { kind: 'error', folder, error: pathError, yamlFiles: [] };
  }
  const yamlFiles = await listYamlFiles(path, folderLabel);
  if (!isValidWorkflowFolderSegment(folder)) {
    const error: WorkflowLoadError = {
      filename: folderLabel,
      error: `Invalid packaged workflow directory '${folderLabel}'.`,
      errorType: 'validation_error',
    };
    return { kind: 'error', folder, error, yamlFiles: Array.isArray(yamlFiles) ? yamlFiles : [] };
  }
  if (!Array.isArray(yamlFiles)) return { kind: 'error', folder, error: yamlFiles, yamlFiles: [] };
  if (yamlFiles.length === 0) return { kind: 'empty', folder };
  if (yamlFiles.length !== 1) {
    return {
      kind: 'error',
      folder,
      error: yamlCountError(folderLabel, yamlFiles.length),
      yamlFiles,
    };
  }
  return { kind: 'workflow', folder, path, filename: yamlFiles[0] };
}

/** A packaged workflow folder must hold exactly one YAML file; `found` is how many it holds. */
export function yamlCountError(folderLabel: string, found: number): WorkflowLoadError {
  return {
    filename: folderLabel,
    error: `Packaged workflow '${folderLabel}' must contain exactly one .yaml or .yml file (found ${found}).`,
    errorType: 'validation_error',
  };
}

async function listYamlFiles(dir: string, label: string): Promise<string[] | WorkflowLoadError> {
  try {
    return sorted((await readdir(dir)).filter(isYamlFile));
  } catch (error) {
    return fileSystemError(label, 'Directory read', error);
  }
}
