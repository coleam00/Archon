import { type ProviderRegistry } from '@archon/provider-contract';
import { readFile, readdir, access, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import type { WorkflowDefinition, WorkflowLoadError, WorkflowSource } from '../schemas';
import { MAX_DISCOVERY_DEPTH } from '../command-validation';
import { parseWorkflow } from '../loader';
import { isValidWorkflowFolderSegment, qualifyWorkflowResources } from '../packaged-workflow';
import { FIXTURES_DIR } from '../fixture-layout';
import { getLog } from './log';

/** What parsing a workflow file needs beyond its content. */
export interface WorkflowParseContext {
  providers: ProviderRegistry;
  /** Env names the exec env-read checker treats as supplied. */
  configuredEnvNames: ReadonlySet<string>;
}

/**
 * One parsed workflow file: its definition plus the non-fatal warnings raised
 * parsing it (unknown keys — #2213).
 *
 * The warnings live ON the entry rather than in a map beside it deliberately.
 * Overrides here are last-writer-wins by bare filename, and a filename can
 * legitimately appear twice (root and a 1-level subfolder). With two parallel
 * maps the winner's definition and the loser's warnings could survive together,
 * telling an author a clean workflow declares a key it does not contain. One
 * value means a single `Map.set()` replaces both halves atomically, so they
 * cannot disagree.
 */
export interface ParsedWorkflowFile {
  filePath?: string;
  workflow: WorkflowDefinition;
  /** Empty for a clean file. */
  parseWarnings: readonly string[];
}

/** A discovered workflow file with the scope it came from. */
export type ScopeFile = ParsedWorkflowFile & { source: WorkflowSource };

export interface DirLoadResult {
  workflows: Map<string, ParsedWorkflowFile>;
  errors: WorkflowLoadError[];
}

/** One workflow loaded from a pack's `<workflow>/` folder. */
export interface PackWorkflowFile {
  folder: string;
  filename: string;
  parsed: ParsedWorkflowFile;
}

/** One pack directory to load: `pack` qualifies its resources, `label` names it in errors. */
export interface PackLoad extends WorkflowParseContext {
  pack: string;
  source: WorkflowSource;
  label: string;
}

export function isYamlFile(entry: string): boolean {
  return entry.endsWith('.yaml') || entry.endsWith('.yml');
}

/** Match the scope loader against an authenticated, slash-separated file inventory. */
export function hasWorkflowFiles(
  files: ReadonlySet<string>,
  flatDirectory: string,
  packagedRoot: string
): boolean {
  return [...files].some(path => {
    if (!isYamlFile(path)) return false;
    if (path.startsWith(`${flatDirectory}/`)) {
      const directories = path
        .slice(flatDirectory.length + 1)
        .split('/')
        .slice(0, -1);
      if (
        directories.length <= MAX_DISCOVERY_DEPTH &&
        directories.every(
          (entry, depth) =>
            entry !== FIXTURES_DIR &&
            !files.has(
              `${flatDirectory}/${directories.slice(0, depth + 1).join('/')}/${PLUGIN_MANIFEST_FILE}`
            )
        )
      )
        return true;
    }
    if (!path.startsWith(`${packagedRoot}/`)) return false;
    const segments = path.slice(packagedRoot.length + 1).split('/');
    const [pack, folder] = segments;
    return (
      segments.length === 3 &&
      pack !== 'defaults' &&
      pack !== FIXTURES_DIR &&
      isValidWorkflowFolderSegment(pack) &&
      folder !== FIXTURES_DIR &&
      isValidWorkflowFolderSegment(folder)
    );
  });
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

/** A failed `stat` of a packaged path: a vanished path is skipped, anything else reported. */
function pathReadError(
  filename: string,
  logContext: Record<string, string>,
  error: unknown
): WorkflowLoadError | undefined {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') return undefined;
  getLog().warn({ err, ...logContext }, 'packaged_workflow_path_read_error');
  return fileSystemError(filename, 'Path read', error);
}

export function mergeScopeResults(base: DirLoadResult, packaged: DirLoadResult): DirLoadResult {
  for (const [filename, parsed] of packaged.workflows) {
    if (!base.workflows.has(filename)) {
      base.workflows.set(filename, parsed);
      continue;
    }

    base.workflows.delete(filename);
    base.errors.push({
      filename,
      error: `Workflow filename collision within one scope: '${filename}'. Workflow filenames must be unique across flat and packaged folders.`,
      errorType: 'validation_error',
    });
  }
  base.errors.push(...packaged.errors);
  return base;
}

/** A scope directory's flat workflows and its packaged workflows, merged. */
export async function loadScopeDirectory(
  context: WorkflowParseContext,
  flatDir: string,
  packagedRoot: string,
  source: WorkflowSource
): Promise<DirLoadResult> {
  return mergeScopeResults(
    await loadWorkflowsFromDir(context, flatDir),
    await loadPackagedWorkflowsFromDir(context, packagedRoot, source)
  );
}

// `MAX_DISCOVERY_DEPTH` (= 1: one level of grouping, e.g.
// `.archon/workflows/team/foo.yaml`) is imported from `command-validation`,
// the dependency-free leaf module, so the loader here and the workflow-name
// validator there share one source of truth and cannot drift apart. We stop at
// one level deliberately — deeper nesting has never been part of the documented
// convention and adds only routing ambiguity.

async function isPackDirectory(dirPath: string): Promise<boolean> {
  try {
    await access(join(dirPath, PLUGIN_MANIFEST_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isWorkflowSubdirectory(
  entryPath: string,
  entry: string,
  depth: number
): Promise<boolean> {
  // A `fixtures/` directory holds fixture data, never workflows, at any depth.
  if (entry === FIXTURES_DIR) return false;
  // Only descend if we're still within the depth cap. Past the cap,
  // subdirectories are ignored (same convention as the paths-package
  // `findCommandFiles` depth cap).
  if (depth >= MAX_DISCOVERY_DEPTH) return false;
  // A directory holding a pack manifest is a pack, read only by the pack loader,
  // so a copied pack loads the same tree the same way as when it was installed.
  return !(await isPackDirectory(entryPath));
}

/**
 * Load workflows from a directory, descending at most `MAX_DISCOVERY_DEPTH`
 * folders deep. Files deeper than the cap are silently skipped.
 * Failures are per-file: one broken file does not abort loading the rest.
 */
export async function loadWorkflowsFromDir(
  context: WorkflowParseContext,
  dirPath: string,
  depth = 0
): Promise<DirLoadResult> {
  const result: DirLoadResult = { workflows: new Map(), errors: [] };
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().debug({ dirPath }, 'workflow_directory_not_found');
    } else {
      getLog().warn({ err, dirPath }, 'workflow_directory_read_error');
      result.errors.push(fileSystemError(dirPath, 'Directory read', error));
    }
    return result;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      await loadDirEntry(context, result, dirPath, entry, depth);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      getLog().warn({ err, entryPath }, 'workflow_file_read_error');
      result.errors.push(fileSystemError(entry, 'File read', error));
    }
  }
  return result;
}

async function loadDirEntry(
  context: WorkflowParseContext,
  into: DirLoadResult,
  dirPath: string,
  entry: string,
  depth: number
): Promise<void> {
  const entryPath = join(dirPath, entry);
  if ((await stat(entryPath)).isDirectory()) {
    if (!(await isWorkflowSubdirectory(entryPath, entry, depth))) return;
    const subResult = await loadWorkflowsFromDir(context, entryPath, depth + 1);
    for (const [filename, parsed] of subResult.workflows) {
      into.workflows.set(filename, parsed);
    }
    into.errors.push(...subResult.errors);
    return;
  }
  if (!isYamlFile(entry)) return;

  const content = await readFile(entryPath, 'utf-8');
  const result = parseWorkflow(content, entry, context.providers, context.configuredEnvNames);
  if (!result.workflow) {
    into.errors.push(result.error);
    return;
  }
  into.workflows.set(entry, {
    workflow: result.workflow,
    parseWarnings: result.warnings,
    filePath: resolve(entryPath),
  });
  getLog().debug({ workflowName: result.workflow.name, dirPath }, 'workflow_loaded');
}

/**
 * Load every `<workflow>/<one>.yaml` of one pack directory, qualifying each workflow's
 * commands and scripts to its own folder.
 */
export async function loadPackWorkflows(
  pack: PackLoad,
  packPath: string
): Promise<{ files: PackWorkflowFile[]; errors: WorkflowLoadError[] }> {
  const files: PackWorkflowFile[] = [];
  const errors: WorkflowLoadError[] = [];
  let workflowFolders: string[];
  try {
    workflowFolders = await readdir(packPath);
  } catch (error) {
    errors.push(fileSystemError(pack.label, 'Directory read', error));
    return { files, errors };
  }
  for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
    // A dot directory (`.shared`, `.github`, ...) is never a workflow folder: a workflow
    // folder name cannot start with a dot. A pack installed from a repository root
    // carries that repository's other directories, so these are expected, not errors.
    if (workflowFolder.startsWith('.')) continue;
    if (workflowFolder === FIXTURES_DIR) continue;
    const loaded = await loadPackWorkflowFolder(pack, packPath, workflowFolder);
    if (loaded === undefined) continue;
    if ('parsed' in loaded) files.push(loaded);
    else errors.push(loaded);
  }

  return { files, errors };
}

/** One `<workflow>/` folder of a pack: its workflow, a load error, or nothing to load. */
async function loadPackWorkflowFolder(
  pack: PackLoad,
  packPath: string,
  workflowFolder: string
): Promise<PackWorkflowFile | WorkflowLoadError | undefined> {
  const workflowPath = join(packPath, workflowFolder);
  const folderLabel = `${pack.label}/${workflowFolder}`;
  try {
    if (!(await stat(workflowPath)).isDirectory()) return undefined;
  } catch (error) {
    return pathReadError(folderLabel, { workflowPath }, error);
  }
  if (!isValidWorkflowFolderSegment(workflowFolder)) {
    return {
      filename: folderLabel,
      error: `Invalid packaged workflow directory '${folderLabel}'.`,
      errorType: 'validation_error',
    };
  }

  let workflowEntries: string[];
  try {
    workflowEntries = await readdir(workflowPath);
  } catch (error) {
    return fileSystemError(folderLabel, 'Directory read', error);
  }
  const yamlFiles = workflowEntries.filter(isYamlFile).sort((a, b) => a.localeCompare(b));
  // A folder with no YAML (tests, docs, assets) holds no workflow. Two or more is an
  // ambiguous workflow folder, and stays an error.
  if (yamlFiles.length === 0) return undefined;
  if (yamlFiles.length !== 1) {
    return {
      filename: folderLabel,
      error: `Packaged workflow '${folderLabel}' must contain exactly one .yaml or .yml file (found ${yamlFiles.length}).`,
      errorType: 'validation_error',
    };
  }

  const filename = yamlFiles[0];
  let content: string;
  try {
    content = await readFile(join(workflowPath, filename), 'utf-8');
  } catch (error) {
    return fileSystemError(`${folderLabel}/${filename}`, 'File read', error);
  }
  const parsed = parseWorkflow(content, filename, pack.providers, pack.configuredEnvNames);
  if (!parsed.workflow) {
    // A scope file's error keeps its bare filename, which resume matches against a
    // run's workflow name. An installed pack's error names the pack and folder.
    return pack.source === 'installed'
      ? { ...parsed.error, filename: `${folderLabel}/${filename}` }
      : parsed.error;
  }
  qualifyWorkflowResources(parsed.workflow, {
    source: pack.source,
    pack: pack.pack,
    workflow: workflowFolder,
  });

  return {
    folder: workflowFolder,
    filename,
    parsed: {
      workflow: parsed.workflow,
      parseWarnings: parsed.warnings,
      filePath: resolve(workflowPath, filename),
    },
  };
}

export async function loadPackagedWorkflowsFromDir(
  context: WorkflowParseContext,
  workflowsRoot: string,
  source: WorkflowSource
): Promise<DirLoadResult> {
  const result: DirLoadResult = { workflows: new Map(), errors: [] };
  const collided = new Set<string>();
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return result;
    getLog().warn({ err, workflowsRoot }, 'packaged_workflow_directory_read_error');
    result.errors.push(fileSystemError(workflowsRoot, 'Directory read', error));
    return result;
  }

  for (const pack of packs.sort((a, b) => a.localeCompare(b))) {
    const loaded = await loadScopePack(
      { ...context, pack, source, label: pack },
      join(workflowsRoot, pack)
    );
    result.errors.push(...loaded.errors);
    for (const { filename, parsed } of loaded.files) {
      if (result.workflows.has(filename) || collided.has(filename)) {
        result.workflows.delete(filename);
        collided.add(filename);
        result.errors.push({
          filename,
          error: `Workflow filename collision across packaged folders: '${filename}'. Workflow filenames must be unique within a scope.`,
          errorType: 'validation_error',
        });
        continue;
      }
      result.workflows.set(filename, parsed);
    }
  }

  return result;
}

/** One pack directory inside a scope's workflow folder. */
async function loadScopePack(
  pack: PackLoad,
  packPath: string
): Promise<{ files: PackWorkflowFile[]; errors: WorkflowLoadError[] }> {
  const skipped = { files: [], errors: [] };
  try {
    if (!(await stat(packPath)).isDirectory()) return skipped;
  } catch (error) {
    const pathError = pathReadError(pack.pack, { packPath }, error);
    return { files: [], errors: pathError === undefined ? [] : [pathError] };
  }
  // `defaults` is the flat-defaults convention, not a pack: loadWorkflowsFromDir
  // reads its files. Captures taken by builds that still bundled flat defaults
  // hold `defaults/legacy/`, which packaged scanning would misread and fail with
  // "must contain exactly one .yaml" on every discovery pass.
  if (pack.pack === 'defaults') return skipped;
  if (pack.pack === FIXTURES_DIR) return skipped;
  if (!isValidWorkflowFolderSegment(pack.pack)) {
    return {
      files: [],
      errors: [
        {
          filename: pack.pack,
          error: `Invalid packaged workflow pack directory '${pack.pack}'.`,
          errorType: 'validation_error',
        },
      ],
    };
  }
  return loadPackWorkflows(pack, packPath);
}
