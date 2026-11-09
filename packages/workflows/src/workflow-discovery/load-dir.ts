import { type ProviderRegistry } from '@archon/provider-contract';
import { readFile, readdir, access, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import type { WorkflowDefinition, WorkflowLoadError, WorkflowSource } from '../schemas';
import { isIncludeDirective } from '../schemas';
import { visitNodeTemplateSlots } from '../template-walker';
import { PACK_DIR_REFERENCE } from '../workflow-variables';
import type { WorkflowPack } from '../schemas/pack-settings';
import { loadPackDeclaration, PackSettingsError } from '../pack-settings';
import { MAX_DISCOVERY_DEPTH } from '../command-validation';
import { parseWorkflow } from '../loader';
import { qualifyWorkflowResources } from '../packaged-workflow';
import { FIXTURES_DIR } from '../fixture-layout';
import { getLog } from './log';
import {
  fileSystemError,
  isYamlFile,
  readPackWorkflowFolders,
  readScopePacks,
  type PackWorkflowLocation,
} from './pack-layout';

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

/**
 * One pack directory to load: `pack` qualifies its resources and keys its settings,
 * `label` names it in errors.
 */
export interface PackLoad extends WorkflowParseContext {
  pack: string;
  source: WorkflowSource;
  label: string;
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
  const packDirReader = findPackDirReference(result.workflow.nodes);
  if (packDirReader !== undefined) {
    into.errors.push({
      filename: entry,
      error: `Node '${packDirReader}' references $PACK_DIR, but this workflow is not in a pack. $PACK_DIR names the pack folder of a packaged workflow (.archon/workflows/<pack>/<workflow>/<workflow>.yaml); move the workflow into one.`,
      errorType: 'validation_error',
    });
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
 * commands and scripts to its own folder and attaching the pack it came from.
 *
 * The pack's settings declaration is read once. An invalid one fails every workflow of
 * the pack, each under its own file: a workflow whose settings cannot be known must not
 * run with a guess at them.
 */
export async function loadPackWorkflows(
  pack: PackLoad,
  packPath: string
): Promise<{ files: PackWorkflowFile[]; errors: WorkflowLoadError[] }> {
  const files: PackWorkflowFile[] = [];
  const errors: WorkflowLoadError[] = [];
  const listing = await readPackWorkflowFolders(packPath, pack.label);
  if ('error' in listing) return { files, errors: [listing.error] };
  let workflowPack: WorkflowPack | PackSettingsError;
  try {
    const settings = await loadPackDeclaration(packPath, pack.label);
    workflowPack = {
      key: pack.pack,
      source: pack.source,
      ...(settings !== undefined ? { settings } : {}),
    };
  } catch (error) {
    if (!(error instanceof PackSettingsError)) throw error;
    getLog().warn({ err: error, packPath }, 'pack_declaration_invalid');
    workflowPack = error;
  }
  for (const entry of listing.folders) {
    if (entry.kind === 'empty') continue;
    if (entry.kind === 'error') {
      errors.push(entry.error);
      continue;
    }
    const loaded = await loadPackWorkflowFile(pack, workflowPack, entry);
    if ('parsed' in loaded) files.push(loaded);
    else errors.push(loaded);
  }

  return { files, errors };
}

/** The one workflow file of a pack's `<workflow>/` folder: its workflow or its load error. */
async function loadPackWorkflowFile(
  pack: PackLoad,
  workflowPack: WorkflowPack | PackSettingsError,
  { folder, path, filename }: PackWorkflowLocation
): Promise<PackWorkflowFile | WorkflowLoadError> {
  const folderLabel = `${pack.label}/${folder}`;
  // A scope file's error keeps its bare filename, which resume matches against a
  // run's workflow name. An installed pack's error names the pack and folder.
  const errorFilename = pack.source === 'installed' ? `${folderLabel}/${filename}` : filename;
  if (workflowPack instanceof PackSettingsError) {
    return { filename: errorFilename, error: workflowPack.message, errorType: 'validation_error' };
  }
  let content: string;
  try {
    content = await readFile(join(path, filename), 'utf-8');
  } catch (error) {
    return fileSystemError(`${folderLabel}/${filename}`, 'File read', error);
  }
  const parsed = parseWorkflow(
    content,
    filename,
    pack.providers,
    pack.configuredEnvNames,
    workflowPack
  );
  if (!parsed.workflow) return { ...parsed.error, filename: errorFilename };
  qualifyWorkflowResources(parsed.workflow, {
    source: pack.source,
    pack: pack.pack,
    workflow: folder,
  });

  return {
    folder,
    filename,
    parsed: {
      workflow: parsed.workflow,
      parseWarnings: parsed.warnings,
      filePath: resolve(path, filename),
    },
  };
}

export async function loadPackagedWorkflowsFromDir(
  context: WorkflowParseContext,
  workflowsRoot: string,
  source: WorkflowSource
): Promise<DirLoadResult> {
  const { packs, errors } = await readScopePacks(workflowsRoot);
  const result: DirLoadResult = { workflows: new Map(), errors };
  const collided = new Set<string>();
  for (const pack of packs) {
    const loaded = await loadPackWorkflows(
      { ...context, pack: pack.name, source, label: pack.name },
      pack.path
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

/**
 * The id of the first node whose YAML text references `$PACK_DIR`. Only a flat or grouped
 * workflow is checked: it has no pack, so the reference could never resolve at run time.
 */
function findPackDirReference(nodes: WorkflowDefinition['nodes']): string | undefined {
  for (const node of nodes) {
    if (isIncludeDirective(node)) continue;
    let found = false;
    visitNodeTemplateSlots(node, slot => {
      if (PACK_DIR_REFERENCE.test(slot.value)) found = true;
    });
    if (found) return node.id;
  }
  return undefined;
}
