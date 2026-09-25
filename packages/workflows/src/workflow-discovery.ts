/**
 * Workflow discovery - finds and loads workflow YAML files from disk.
 *
 * Extracted from loader.ts so that file can focus on YAML parsing.
 * This module handles directory traversal, bundled defaults, and the
 * full discoverWorkflows entry point.
 *
 * Imports parseWorkflow from loader.ts (parsing concern stays there).
 *
 * Scopes (precedence lowest → highest):
 *   1. `bundled` — embedded in the Archon binary (or read from the packs
 *      `bundle-index.json` names, under the app's `.archon/workflows/`, in source mode).
 *   2. `global`  — home-scoped at `~/.archon/workflows/`. Applies to every
 *      repo; discovered automatically (no caller option needed).
 *   3. `project` — repo-local at `<cwd>/.archon/workflows/`.
 *
 * Same-named files at a higher scope override those at lower scopes.
 *
 * Installed workflow packs (`archon plugin install`) are a fourth source outside that
 * precedence: each pack resolves its includes within itself, and only its manifest
 * entrypoints are dispatchable, as `owner/plugin:<entrypoint>`.
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { basename, join } from 'path';
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  WorkflowLoadResult,
  WorkflowWithSource,
  WorkflowSource,
  DeclaredWorkflowConfig,
  DagNode,
  IncludeDirective,
} from './schemas';
import { isComposeFanOutNode, isIncludeDirective, isLoopGroupNode } from './schemas';
import * as archonPaths from '@archon/paths';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import {
  assertWorkflowSourceIntegrity,
  installedWorkflowName,
  listInstalledPacks,
  liveSourceRoots,
  packagedWorkflowDirectory,
  workflowSourceConfigForRoots,
  type WorkflowSourceRoots,
} from './workflow-source';
// Re-exported here because this is the module callers already import to discover with.
export { liveSourceRoots } from './workflow-source';
export type { WorkflowSourceRoots } from './workflow-source';
import {
  BUNDLED_WORKFLOWS,
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOW_PATHS,
  isBinaryBuild,
} from './defaults/bundled-defaults';
import {
  bundlesPackagedResources,
  collectInstalledBundleSources,
  readBundleContent,
} from './defaults/bundle-inventory';
import { createLogger } from '@archon/paths';
import { isValidCommandName, MAX_DISCOVERY_DEPTH } from './command-validation';
import { parseWorkflow, collectLoopGroupSinkWarnings } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import { collectFileBackedCommandNames } from './command-file';
import {
  isValidWorkflowFolderSegment,
  parsePackagedResourceReference,
  qualifyPackReferences,
  qualifyWorkflowResources,
} from './packaged-workflow';
import type { IncludeCommandContent } from './compiled-command';
import { discoverScriptsForCwd } from './script-discovery';
import { FIXTURES_DIR } from './fixture-layout';
import {
  collectExecInputValidationTargets,
  inlineExecInputSource,
  validateExecInputTargets,
  type ExecInputSource,
  type ExecInputValidationTarget,
} from './exec-input-validation';

export { isValidWorkflowFolderSegment } from './packaged-workflow';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.discovery');
  return cachedLog;
}

/**
 * One-time deprecation warning for the pre-refactor `~/.archon/.archon/workflows/`
 * location. Scoped to the process so the warning fires exactly once regardless
 * of how many times discovery runs.
 *
 * The legacy path is ONLY probed for detection — workflows placed there are not
 * read. Users migrate manually via the `mv` command printed in the warning.
 * Exported so tests can reset it between cases.
 */
let hasWarnedLegacyHomePath = false;
export function resetLegacyHomeWarningForTests(): void {
  hasWarnedLegacyHomePath = false;
}

async function maybeWarnLegacyHomePath(): Promise<void> {
  if (hasWarnedLegacyHomePath) return;
  // Set the flag eagerly so concurrent discovery calls (e.g. parallel codebase
  // resolution at server startup) can't both pass the guard and double-warn.
  hasWarnedLegacyHomePath = true;

  const legacyPath = archonPaths.getLegacyHomeWorkflowsPath();
  const newPath = archonPaths.getHomeWorkflowsPath();
  try {
    await access(legacyPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // happy path — legacy location not in use
    // EACCES/EPERM/EIO: directory exists but we can't read it. Surface at WARN
    // so the user sees it — silent debug would hide a real permission issue.
    getLog().warn({ err, legacyPath }, 'workflow.legacy_home_path_probe_error');
    return;
  }
  // Legacy directory exists — surface an actionable migration hint exactly once.
  const moveCommand = `mv "${legacyPath}" "${newPath}" && rmdir "${join(archonPaths.getArchonHome(), '.archon')}"`;
  getLog().warn({ legacyPath, newPath, moveCommand }, 'workflow.legacy_home_path_detected');
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
interface ParsedWorkflowFile {
  workflow: WorkflowDefinition;
  /** Empty for a clean file. */
  parseWarnings: readonly string[];
}

/** A discovered workflow file with the scope it came from. */
type ScopeFile = ParsedWorkflowFile & { source: WorkflowSource };

interface DirLoadResult {
  workflows: Map<string, ParsedWorkflowFile>;
  errors: WorkflowLoadError[];
}

function mergeScopeResults(base: DirLoadResult, packaged: DirLoadResult): DirLoadResult {
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

/**
 * Load workflows from a directory, descending at most `MAX_DISCOVERY_DEPTH`
 * folders deep. Files deeper than the cap are silently skipped.
 * Failures are per-file: one broken file does not abort loading the rest.
 */
async function loadWorkflowsFromDir(dirPath: string, depth = 0): Promise<DirLoadResult> {
  const workflows = new Map<string, ParsedWorkflowFile>();
  const errors: WorkflowLoadError[] = [];

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);

      try {
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          // A `fixtures/` directory holds fixture data, never workflows, at any depth.
          if (entry === FIXTURES_DIR) continue;
          // Only descend if we're still within the depth cap. Past the cap,
          // subdirectories are ignored (same convention as the paths-package
          // `findCommandFiles` depth cap).
          if (depth >= MAX_DISCOVERY_DEPTH) continue;
          // A directory holding a pack manifest is a pack, read only by the pack loader,
          // so a copied pack loads the same tree the same way as when it was installed.
          if (await isPackDirectory(entryPath)) continue;
          const subResult = await loadWorkflowsFromDir(entryPath, depth + 1);
          for (const [filename, parsed] of subResult.workflows) {
            workflows.set(filename, parsed);
          }
          errors.push(...subResult.errors);
        } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          const content = await readFile(entryPath, 'utf-8');
          const result = parseWorkflow(content, entry);

          if (result.workflow) {
            workflows.set(entry, { workflow: result.workflow, parseWarnings: result.warnings });
            getLog().debug({ workflowName: result.workflow.name, dirPath }, 'workflow_loaded');
          } else {
            errors.push(result.error);
          }
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        getLog().warn({ err, entryPath }, 'workflow_file_read_error');
        errors.push({
          filename: entry,
          error: `File read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().debug({ dirPath }, 'workflow_directory_not_found');
    } else {
      getLog().warn({ err, dirPath }, 'workflow_directory_read_error');
      errors.push({
        filename: dirPath,
        error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
        errorType: 'read_error',
      });
    }
  }

  return { workflows, errors };
}

/** One workflow loaded from a pack's `<workflow>/` folder. */
interface PackWorkflowFile {
  folder: string;
  filename: string;
  parsed: ParsedWorkflowFile;
}

/**
 * Load every `<workflow>/<one>.yaml` of one pack directory, qualifying each workflow's
 * commands and scripts to its own folder. `label` names the pack in errors.
 */
async function loadPackWorkflows(
  packPath: string,
  pack: string,
  source: WorkflowSource,
  label = pack
): Promise<{ files: PackWorkflowFile[]; errors: WorkflowLoadError[] }> {
  const files: PackWorkflowFile[] = [];
  const errors: WorkflowLoadError[] = [];
  let workflowFolders: string[];
  try {
    workflowFolders = await readdir(packPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    errors.push({
      filename: label,
      error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
      errorType: 'read_error',
    });
    return { files, errors };
  }
  for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
    // A dot directory (`.shared`, `.github`, ...) is never a workflow folder: a workflow
    // folder name cannot start with a dot. A pack installed from a repository root
    // carries that repository's other directories, so these are expected, not errors.
    if (workflowFolder.startsWith('.')) continue;
    if (workflowFolder === FIXTURES_DIR) continue;
    const workflowPath = join(packPath, workflowFolder);
    try {
      if (!(await stat(workflowPath)).isDirectory()) continue;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, workflowPath }, 'packaged_workflow_path_read_error');
        errors.push({
          filename: `${label}/${workflowFolder}`,
          error: `Path read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
      }
      continue;
    }
    if (!isValidWorkflowFolderSegment(workflowFolder)) {
      errors.push({
        filename: `${label}/${workflowFolder}`,
        error: `Invalid packaged workflow directory '${label}/${workflowFolder}'.`,
        errorType: 'validation_error',
      });
      continue;
    }

    let workflowEntries: string[];
    try {
      workflowEntries = await readdir(workflowPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      errors.push({
        filename: `${label}/${workflowFolder}`,
        error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
        errorType: 'read_error',
      });
      continue;
    }
    const yamlFiles = workflowEntries
      .filter(entry => entry.endsWith('.yaml') || entry.endsWith('.yml'))
      .sort((a, b) => a.localeCompare(b));
    // A folder with no YAML (tests, docs, assets) holds no workflow. Two or more is an
    // ambiguous workflow folder, and stays an error.
    if (yamlFiles.length === 0) continue;
    if (yamlFiles.length !== 1) {
      errors.push({
        filename: `${label}/${workflowFolder}`,
        error: `Packaged workflow '${label}/${workflowFolder}' must contain exactly one .yaml or .yml file (found ${yamlFiles.length}).`,
        errorType: 'validation_error',
      });
      continue;
    }

    const filename = yamlFiles[0];
    let content: string;
    try {
      content = await readFile(join(workflowPath, filename), 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      errors.push({
        filename: `${label}/${workflowFolder}/${filename}`,
        error: `File read error: ${err.message} (${err.code ?? 'unknown'})`,
        errorType: 'read_error',
      });
      continue;
    }
    const parsed = parseWorkflow(content, filename);
    if (!parsed.workflow) {
      // A scope file's error keeps its bare filename, which resume matches against a
      // run's workflow name. An installed pack's error names the pack and folder.
      errors.push(
        source === 'installed'
          ? { ...parsed.error, filename: `${label}/${workflowFolder}/${filename}` }
          : parsed.error
      );
      continue;
    }
    qualifyWorkflowResources(parsed.workflow, { source, pack, workflow: workflowFolder });

    files.push({
      folder: workflowFolder,
      filename,
      parsed: { workflow: parsed.workflow, parseWarnings: parsed.warnings },
    });
  }

  return { files, errors };
}

async function loadPackagedWorkflowsFromDir(
  workflowsRoot: string,
  source: WorkflowSource
): Promise<DirLoadResult> {
  const workflows = new Map<string, ParsedWorkflowFile>();
  const errors: WorkflowLoadError[] = [];
  const collided = new Set<string>();
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { workflows, errors };
    getLog().warn({ err, workflowsRoot }, 'packaged_workflow_directory_read_error');
    errors.push({
      filename: workflowsRoot,
      error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
      errorType: 'read_error',
    });
    return { workflows, errors };
  }

  for (const pack of packs.sort((a, b) => a.localeCompare(b))) {
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, packPath }, 'packaged_workflow_path_read_error');
        errors.push({
          filename: pack,
          error: `Path read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
      }
      continue;
    }
    // `defaults` is the flat-defaults convention, not a pack: loadWorkflowsFromDir
    // reads its files. Captures taken by builds that still bundled flat defaults
    // hold `defaults/legacy/`, which packaged scanning would misread and fail with
    // "must contain exactly one .yaml" on every discovery pass.
    if (pack === 'defaults') continue;
    if (pack === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(pack)) {
      errors.push({
        filename: pack,
        error: `Invalid packaged workflow pack directory '${pack}'.`,
        errorType: 'validation_error',
      });
      continue;
    }

    const loaded = await loadPackWorkflows(packPath, pack, source);
    errors.push(...loaded.errors);
    for (const { filename, parsed } of loaded.files) {
      if (workflows.has(filename) || collided.has(filename)) {
        workflows.delete(filename);
        collided.add(filename);
        errors.push({
          filename,
          error: `Workflow filename collision across packaged folders: '${filename}'. Workflow filenames must be unique within a scope.`,
          errorType: 'validation_error',
        });
        continue;
      }
      workflows.set(filename, parsed);
    }
  }

  return { workflows, errors };
}

/**
 * Load bundled default workflows (for binary distribution)
 * Returns a Map of filename -> workflow for consistency with loadWorkflowsFromDir
 *
 * Note: Bundled workflows are embedded at compile time and should ALWAYS be valid.
 * Parse failures indicate a build-time corruption and are logged as errors.
 */
function loadBundledWorkflows(): DirLoadResult {
  const workflows = new Map<string, ParsedWorkflowFile>();
  const errors: WorkflowLoadError[] = [];

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const path = BUNDLED_WORKFLOW_PATHS[name];
    if (path === undefined) throw new Error(`Bundled workflow "${name}" has no source path.`);
    const filename = basename(path);
    const result = parseWorkflow(content, filename);
    if (result.workflow) {
      const owner = BUNDLED_WORKFLOW_OWNERS[name];
      if (owner !== undefined) {
        qualifyWorkflowResources(result.workflow, { source: 'bundled', ...owner });
      }
      workflows.set(filename, { workflow: result.workflow, parseWarnings: result.warnings });
      getLog().debug({ workflowName: result.workflow.name }, 'bundled_workflow_loaded');
    } else {
      // Bundled workflows should ALWAYS be valid - this indicates a build-time error
      getLog().error(
        { filename, contentPreview: content.slice(0, 200) + '...' },
        'bundled_workflow_parse_failed'
      );
      errors.push(result.error);
    }
  }

  return { workflows, errors };
}

/**
 * Command-resolution config that keeps the include safety scan at parity with the
 * runtime/validator command lookup: the configured extra `commandFolder` and the
 * `loadDefaultCommands` opt-out. Threaded from `discoverWorkflowsWithConfig` (which loads
 * `.archon/config.yaml`); direct `discoverWorkflows` callers get the defaults.
 */
interface CommandScanConfig {
  commandFolder?: string;
  loadDefaultCommands?: boolean;
}

/**
 * Resolve a command name to its file CONTENT, mirroring the runtime/validator search
 * order (repo `.archon/commands/` + configured `commandFolder` → `~/.archon/commands/` →
 * a capture's frozen flat defaults, unless `loadDefaultCommands` is false). Returns `null` when no candidate
 * resolves, and a path-bearing error when a higher-precedence scope cannot be inspected or a
 * matched candidate cannot be read. Read-only; used so the include expander can compile a
 * block's command body while proving its lexical reference boundary.
 */
async function resolveCommandContentForScan(
  roots: WorkflowSourceRoots,
  commandName: string,
  config: CommandScanConfig
): Promise<IncludeCommandContent> {
  if (!isValidCommandName(commandName)) return null;

  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) {
    if (packaged.owner.source === 'bundled') {
      if (config.loadDefaultCommands === false) return null;
      // A captured run reads the bundled bytes IT froze; the capture materialized a
      // binary's embedded constants to files.
      if (isBinaryBuild() && roots.kind === 'live') return BUNDLED_COMMANDS[commandName] ?? null;
      if (roots.kind === 'live' && !(await bundlesPackagedResources(packaged.owner.pack)))
        return null;
    }

    const workflowDir = await packagedWorkflowDirectory(roots, packaged.owner);
    if (workflowDir === null) return null;
    const commandPath = join(workflowDir, 'commands', `${packaged.name}.md`);
    try {
      return await readFile(commandPath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      return { path: commandPath, message: err.message, operation: 'read' };
    }
  }

  const dirs: string[] = [];
  if (roots.project !== null) {
    // Pass the configured folder so a repo with a custom command directory is scanned
    // (not silently skipped → downgraded to WARN). Matches getCommandFolderSearchPaths use
    // in the validator/executor.
    for (const folder of archonPaths.getCommandFolderSearchPaths(config.commandFolder)) {
      dirs.push(join(roots.project, folder));
    }
  }
  dirs.push(roots.globalCommands);

  for (const dir of dirs) {
    let entries: Awaited<ReturnType<typeof archonPaths.findCommandFiles>>;
    try {
      entries = await archonPaths.findCommandFiles(dir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue;
      return { path: dir, message: err.message, operation: 'inspect' };
    }
    const match = entries.find(e => e.commandName === commandName);
    if (!match) continue;
    const commandPath = join(dir, match.relativePath);
    try {
      return await readFile(commandPath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return { path: commandPath, message: err.message, operation: 'read' };
    }
  }

  // Every bundled command a build ships now is packaged and resolved above. A run captured
  // by an older build may have frozen flat bundled commands and keeps the basename walk
  // over them — unless the repo opted out (loadDefaultCommands: false), matching discovery.
  if (config.loadDefaultCommands === false || roots.kind !== 'captured') return null;
  const defaultsDir = roots.bundledCommands;
  let entries: Awaited<ReturnType<typeof archonPaths.findCommandFiles>>;
  try {
    entries = await archonPaths.findCommandFiles(defaultsDir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    return { path: defaultsDir, message: err.message, operation: 'inspect' };
  }
  const match = entries.find(e => e.commandName === commandName);
  if (!match) return null;
  const commandPath = join(defaultsDir, match.relativePath);
  try {
    return await readFile(commandPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { path: commandPath, message: err.message, operation: 'read' };
  }
}

/**
 * Pre-resolve command-file contents for every file-backed command node (including
 * `loop.command`) that lives in a workflow reachable as an `include:` target
 * (transitively). The include expander uses these to validate deferred prompt bodies.
 * Touches disk only when includes exist; returns an empty map otherwise.
 */
async function resolveIncludeBlockCommandContents(
  roots: WorkflowSourceRoots,
  byName: ReadonlyMap<string, WorkflowDefinition>,
  config: CommandScanConfig
): Promise<Map<string, IncludeCommandContent>> {
  const targetNames = new Set<string>();
  const visitNodes = (nodes: readonly (DagNode | IncludeDirective)[]): void => {
    for (const node of nodes) {
      if (!isIncludeDirective(node) && isLoopGroupNode(node)) visitNodes(node.loop_group.nodes);
      const targetName =
        isIncludeDirective(node) || isComposeFanOutNode(node) ? node.include : undefined;
      if (targetName === undefined || targetNames.has(targetName)) continue;
      targetNames.add(targetName);
      const target = byName.get(targetName);
      if (target) visit(target);
    }
  };
  const visit = (workflow: WorkflowDefinition): void => {
    visitNodes(workflow.nodes);
  };
  for (const workflow of byName.values()) visit(workflow);

  const contents = new Map<string, IncludeCommandContent>();
  if (targetNames.size === 0) return contents; // no includes → nothing to scan
  for (const name of targetNames) {
    const workflow = byName.get(name);
    if (!workflow) continue;
    for (const commandName of collectFileBackedCommandNames(workflow.nodes)) {
      if (!contents.has(commandName)) {
        contents.set(commandName, await resolveCommandContentForScan(roots, commandName, config));
      }
    }
  }
  return contents;
}

/**
 * Resolve file-backed command bodies for runtime composition from the same frozen
 * source roots discovery used. Static include expansion normally owns this step;
 * composed fan-out reuses it when materializing its load-resolved body per item.
 */
export async function resolveWorkflowCommandContents(
  roots: WorkflowSourceRoots,
  workflows: readonly {
    readonly nodes: readonly (DagNode | IncludeDirective)[];
  }[]
): Promise<Map<string, IncludeCommandContent>> {
  const sourceConfig = workflowSourceConfigForRoots(roots);
  const contents = new Map<string, IncludeCommandContent>();
  for (const workflow of workflows) {
    for (const commandName of collectFileBackedCommandNames(workflow.nodes)) {
      if (contents.has(commandName)) continue;
      contents.set(
        commandName,
        await resolveCommandContentForScan(roots, commandName, {
          commandFolder: sourceConfig.command_folder,
          loadDefaultCommands: sourceConfig.load_default_commands,
        })
      );
    }
  }
  return contents;
}

/**
 * Discover and load workflows from codebase.
 *
 * Loads three scopes in order (later overrides earlier by filename):
 *   1. Bundled defaults (unless `options.loadDefaults === false`).
 *   2. Home-scoped `~/.archon/workflows/` — classified as `source: 'global'`.
 *      No caller option: every caller gets home-scoped discovery for free.
 *   3. Repo-scoped `<cwd>/.archon/workflows/` — classified as `source: 'project'`.
 *      Skipped when `cwd` is `null` (no project context — e.g. fresh deployment
 *      where no codebase has been registered yet).
 *
 * When running as a compiled binary, bundled defaults are loaded from embedded
 * content. In source/dev mode they're loaded from the filesystem.
 *
 * Migration: if the retired `~/.archon/.archon/workflows/` path exists, the
 * first call per process logs a WARN with the exact `mv` command. The legacy
 * location is not read — users must migrate manually.
 */
export async function discoverWorkflows(
  cwd: string | null,
  options?: {
    loadDefaults?: boolean;
    commandFolder?: string;
    loadDefaultCommands?: boolean;
    /**
     * Roots to read workflows, commands, and scripts from, when that is not the working
     * directory. An executing run passes the roots of its frozen source capture, so the
     * graph a resume reloads — including any statically included global or bundled
     * workflow — is the one the run started with. Defaults to reading `cwd` live, which
     * is correct for every listing and in-place caller.
     */
    sourceRoots?: WorkflowSourceRoots;
  }
): Promise<WorkflowLoadResult> {
  const roots = options?.sourceRoots ?? liveSourceRoots(cwd);
  await assertWorkflowSourceIntegrity(roots);
  const projectRoot = roots.project;
  // Map of filename -> workflow + source + parse warnings, for deduplication.
  // A later scope's `set()` replaces all three together, so a clean project file
  // can never inherit the bundled file's warnings (see ParsedWorkflowFile).
  const workflowsByFile = new Map<string, ScopeFile>();
  const allErrors: WorkflowLoadError[] = [];

  const validateNamedScripts = async (files: Map<string, ScopeFile>): Promise<void> => {
    const targetsByFile = new Map<
      string,
      { workflow: WorkflowDefinition; targets: readonly ExecInputValidationTarget[] }
    >();
    for (const [filename, { workflow }] of files) {
      const targets = collectExecInputValidationTargets(workflow).filter(
        target => inlineExecInputSource(target) === undefined
      );
      if (targets.length > 0) targetsByFile.set(filename, { workflow, targets });
    }
    if (targetsByFile.size === 0) return;

    const discoveryRoot = projectRoot ?? cwd ?? archonPaths.getArchonHome();
    const scripts = await discoverScriptsForCwd(discoveryRoot, roots);
    const contents = new Map<string, string>();
    const readErrors = new Map<string, Error>();
    const readScript = async (path: string): Promise<string> => {
      const cached = contents.get(path);
      if (cached !== undefined || contents.has(path)) return cached ?? '';
      const priorError = readErrors.get(path);
      if (priorError !== undefined) throw priorError;
      try {
        const content = await readFile(path, 'utf-8');
        contents.set(path, content);
        return content;
      } catch (error) {
        const readError = error instanceof Error ? error : new Error(String(error));
        readErrors.set(path, readError);
        throw readError;
      }
    };

    for (const [filename, { workflow, targets }] of targetsByFile) {
      const sources = new Map<ExecInputValidationTarget, ExecInputSource>();
      let unreadable = false;
      for (const target of targets) {
        const script = scripts.get(target.slot.value);
        if (script === undefined) {
          if (parsePackagedResourceReference(target.slot.value) === null) continue;
          allErrors.push({
            filename,
            error: `Named packaged script '${target.slot.value}' was not found in its workflow's scripts directory.`,
            errorType: 'validation_error',
          });
          files.delete(filename);
          unreadable = true;
          break;
        }
        try {
          sources.set(target, {
            text: await readScript(script.path),
            label: script.path,
            runtime: script.runtime,
          });
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          allErrors.push({
            filename,
            error: `Script file read error at '${script.path}': ${err.message} (${err.code ?? 'unknown'})`,
            errorType: 'read_error',
          });
          files.delete(filename);
          unreadable = true;
          break;
        }
      }
      if (unreadable) continue;

      const validation = validateExecInputTargets(workflow, targets, target => sources.get(target));
      if (validation.errors.length > 0) {
        allErrors.push({
          filename,
          error: validation.errors.join(' '),
          errorType: 'validation_error',
        });
        files.delete(filename);
        continue;
      }
      if (validation.warnings.length > 0) {
        const parsed = files.get(filename);
        if (parsed !== undefined) {
          files.set(filename, {
            ...parsed,
            parseWarnings: [...parsed.parseWarnings, ...validation.warnings],
          });
        }
      }
    }
  };

  /**
   * Final discovery step: inline every `include:` node (see include-expander.ts).
   * Resolves include targets against the full name map (bundled < global < project
   * precedence already applied to `files`), then swaps each workflow for
   * its flattened, namespaced form. A workflow that fails to expand is dropped and
   * its error surfaced via `allErrors`. Only `.workflow` changes — `source` is kept.
   */
  const expandScope = async (files: Map<string, ScopeFile>): Promise<WorkflowWithSource[]> => {
    await validateNamedScripts(files);
    // Overrides are by FILENAME, but include targets resolve by workflow NAME. Two
    // surviving files (after filename-precedence) declaring the same `name:` would
    // silently collapse in the name map — last-writer-wins, emitting the same expanded
    // workflow under both filenames with the wrong source label and making include
    // resolution order-dependent. Detect the collision and error the offending files
    // instead (resilient: drop only the colliding entries, keep discovering the rest).
    // Same-name shadowing was already ambiguous before `include:`; the name map just made
    // it load-bearing, so this hardens a pre-existing gap.
    const filenamesByName = new Map<string, string[]>();
    for (const [filename, { workflow }] of files) {
      const existing = filenamesByName.get(workflow.name);
      if (existing) existing.push(filename);
      else filenamesByName.set(workflow.name, [filename]);
    }
    const duplicateNames = new Set<string>();
    for (const [name, filenames] of filenamesByName) {
      if (filenames.length > 1) {
        duplicateNames.add(name);
        for (const filename of filenames) {
          allErrors.push({
            filename,
            error: `Duplicate workflow name '${name}' — also declared in ${filenames
              .filter(f => f !== filename)
              .join(
                ', '
              )}. Workflow names must be unique; same-name files do not override each other (overrides are by filename).`,
            errorType: 'validation_error',
          });
        }
      }
    }

    const rawByName = new Map<string, WorkflowDefinition>();
    // Map workflow NAME → its real filename, so expansion errors (keyed by name inside the
    // pure expander) can be reported against the includer's actual file. Duplicate names
    // are excluded from expansion above, so first-seen is unambiguous for the rest.
    const filenameByName = new Map<string, string>();
    for (const [filename, { workflow }] of files) {
      if (duplicateNames.has(workflow.name)) continue; // ambiguous — errored above, excluded
      rawByName.set(workflow.name, workflow);
      if (!filenameByName.has(workflow.name)) filenameByName.set(workflow.name, filename);
    }
    // Pre-resolve command-file contents for include-target command nodes so the expander
    // can catch a block command file that references a sibling id namespacing renames.
    const commandContents = await resolveIncludeBlockCommandContents(roots, rawByName, {
      commandFolder: options?.commandFolder,
      loadDefaultCommands: options?.loadDefaultCommands,
    });
    const { workflows: expandedByName, errors: expansionErrors } = expandWorkflowIncludes(
      rawByName,
      commandContents
    );
    // Re-key expansion errors from workflow name to the includer's real filename.
    allErrors.push(
      ...expansionErrors.map(e => ({
        ...e,
        filename: filenameByName.get(e.filename) ?? e.filename,
      }))
    );

    const result: WorkflowWithSource[] = [];
    for (const { workflow, source, parseWarnings } of files.values()) {
      if (duplicateNames.has(workflow.name)) continue; // dropped as a duplicate-name collision
      const expanded = expandedByName.get(workflow.name);
      if (!expanded) continue; // expansion failed for this workflow — drop it
      // Expansion collapses workflow-level node config onto the nodes and removes it
      // (#1764), so the RAW parse is the only place left that knows what the author
      // wrote. Captured here, where both forms are in hand, for display surfaces.
      const declared: DeclaredWorkflowConfig = {
        ...(workflow.provider !== undefined ? { provider: workflow.provider } : {}),
        ...(workflow.model !== undefined ? { model: workflow.model } : {}),
        ...(workflow.effort !== undefined ? { effort: workflow.effort } : {}),
      };
      // The loop_group sink-shape verdicts belong to the EXPANDED graph (#2756): a body
      // whose terminal sink arrives through `include:` is an opaque target name until
      // here, so judging it at parse time silently cleared shapes it could not see.
      // This is the check's only pass — a directly-authored sink keeps its id through
      // expansion, so it is reported here exactly once too.
      const warnings = [...parseWarnings];
      collectLoopGroupSinkWarnings(expanded.nodes, warnings);
      result.push({
        workflow: expanded,
        source,
        // Omitted rather than empty, matching the `errors` field on the same
        // surfaces: presence alone is the signal.
        ...(warnings.length > 0 ? { parseWarnings: warnings } : {}),
        ...(Object.keys(declared).length > 0 ? { declared } : {}),
      });
    }
    return result;
  };

  /**
   * Installed workflow packs, each expanded against its own name map, so its support
   * workflows compose inside the pack and nowhere else. Only manifest entrypoints come
   * back as dispatchable, named `owner/plugin:<entrypoint>`; the rest are support.
   */
  const discoverInstalled = async (): Promise<{
    workflows: WorkflowWithSource[];
    support: WorkflowWithSource[];
  }> => {
    const workflows: WorkflowWithSource[] = [];
    const support: WorkflowWithSource[] = [];
    const listed = await listInstalledPacks(roots.installed);
    for (const { path, message } of listed.errors) {
      allErrors.push({ filename: path, error: message, errorType: 'read_error' });
    }
    for (const pack of listed.packs) {
      const label = `${pack.owner}/${pack.name}`;
      const loaded = await loadPackWorkflows(pack.dir, pack.key, 'installed', label);
      allErrors.push(...loaded.errors);
      const entrypointByPath = new Map(
        Object.entries(pack.manifest.entrypoints).map(([entry, path]) => [path, entry])
      );
      // A pack workflow is referred to inside its pack by its `name:`. It is known
      // outside as owner/plugin:<entrypoint> (entrypoints) or owner/plugin:<name> (support).
      const qualifiedByName = new Map<string, string>();
      const entrypoints = new Set<string>();
      for (const file of loaded.files) {
        const entry = entrypointByPath.get(`${file.folder}/${file.filename}`);
        const qualified = installedWorkflowName(pack, entry ?? file.parsed.workflow.name);
        if (entry !== undefined) entrypoints.add(qualified);
        qualifiedByName.set(file.parsed.workflow.name, qualified);
      }
      for (const [path, entry] of entrypointByPath) {
        if (!loaded.files.some(file => `${file.folder}/${file.filename}` === path)) {
          allErrors.push({
            filename: `${label}/${path}`,
            error: `Entrypoint '${entry}' of installed plugin ${label} did not load from ${path}.`,
            errorType: 'validation_error',
          });
        }
      }
      const files = new Map<string, ScopeFile>();
      for (const file of loaded.files) {
        const { workflow } = file.parsed;
        const filename = `${label}/${file.folder}/${file.filename}`;
        const supportChildren = qualifyPackReferences(workflow, qualifiedByName, entrypoints);
        if (supportChildren.length > 0) {
          allErrors.push({
            filename,
            error: `'workflow:' launches support workflow ${supportChildren.map(name => `'${name}'`).join(', ')} as a child run. A child run is dispatch, and only entrypoints are dispatchable: compose it with 'include:', or declare it as an entrypoint in archon-plugin.json.`,
            errorType: 'validation_error',
          });
          continue;
        }
        files.set(filename, {
          ...file.parsed,
          workflow: { ...workflow, name: qualifiedByName.get(workflow.name) ?? workflow.name },
          source: 'installed',
        });
      }
      for (const expanded of await expandScope(files)) {
        (entrypoints.has(expanded.workflow.name) ? workflows : support).push(expanded);
      }
    }
    return { workflows, support };
  };

  /**
   * Assemble the catalog: the legacy scopes, then installed entrypoints. A qualified
   * installed name wins over a legacy workflow declaring the same name, so no project or
   * global file can shadow an installed workflow.
   */
  const finish = async (scope?: string): Promise<WorkflowLoadResult> => {
    const legacy = await expandScope(workflowsByFile);
    const installed = await discoverInstalled();
    const installedNames = new Set(
      [...installed.workflows, ...installed.support].map(entry => entry.workflow.name)
    );
    const workflows: WorkflowWithSource[] = [];
    for (const entry of legacy) {
      if (installedNames.has(entry.workflow.name)) {
        allErrors.push({
          filename: entry.workflow.name,
          error: `The ${entry.source} workflow named '${entry.workflow.name}' is not loaded: that name belongs to an installed plugin. Rename it.`,
          errorType: 'validation_error',
        });
        continue;
      }
      workflows.push(entry);
    }
    workflows.push(...installed.workflows);
    getLog().info(
      {
        count: workflows.length,
        errorCount: allErrors.length,
        ...(scope !== undefined ? { scope } : {}),
      },
      'workflows_discovery_completed'
    );
    return { workflows, support: installed.support, errors: allErrors };
  };

  // 1. Load from app's bundled defaults (unless opted out)
  const loadDefaultWorkflows = options?.loadDefaults !== false;
  if (loadDefaultWorkflows) {
    // A captured run loads the bundled workflows IT froze — including in a binary, where
    // the capture wrote the embedded constants out as files. That is what lets a paused
    // run resume across an upgrade instead of failing on unverifiable bundled bytes.
    if (isBinaryBuild() && roots.kind === 'live') {
      // Binary: load from embedded bundled content
      getLog().debug('loading_bundled_default_workflows');
      const bundledResult = loadBundledWorkflows();
      for (const [filename, parsed] of bundledResult.workflows) {
        workflowsByFile.set(filename, { ...parsed, source: 'bundled' });
      }
      allErrors.push(...bundledResult.errors);
      getLog().info({ count: bundledResult.workflows.size }, 'bundled_default_workflows_loaded');
    } else {
      // Bun: load from filesystem (development mode)
      const appWorkflowsPath = roots.bundledWorkflows;
      const appDefaultsPath = join(
        appWorkflowsPath,
        basename(archonPaths.getDefaultWorkflowsPath())
      );
      getLog().debug({ appWorkflowsPath }, 'loading_app_default_workflows');
      try {
        let appResult: DirLoadResult;
        if (roots.kind === 'live') {
          appResult = { workflows: new Map(), errors: [] };
          const files = (await collectInstalledBundleSources(appWorkflowsPath)) ?? [];
          for (const file of files) {
            if (file.kind !== 'workflow') continue;
            const filename = basename(file.sourcePath);
            const parsed = parseWorkflow(await readBundleContent(file), filename);
            if (!parsed.workflow) {
              appResult.errors.push(parsed.error);
              continue;
            }
            if (file.owner)
              qualifyWorkflowResources(parsed.workflow, { source: 'bundled', ...file.owner });
            appResult.workflows.set(filename, {
              workflow: parsed.workflow,
              parseWarnings: parsed.warnings,
            });
          }
        } else {
          // A capture's inventory belongs to that run, including packs no longer shipped.
          await access(appWorkflowsPath);
          appResult = mergeScopeResults(
            await loadWorkflowsFromDir(appDefaultsPath),
            await loadPackagedWorkflowsFromDir(appWorkflowsPath, 'bundled')
          );
        }
        for (const [filename, parsed] of appResult.workflows) {
          workflowsByFile.set(filename, { ...parsed, source: 'bundled' });
        }
        if (appResult.errors.length > 0) {
          getLog().warn(
            { errorCount: appResult.errors.length, errors: appResult.errors },
            'app_default_workflow_errors'
          );
          allErrors.push(...appResult.errors);
        }
        getLog().info({ count: appResult.workflows.size }, 'app_default_workflows_loaded');
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (roots.kind === 'live' || err.code !== 'ENOENT') {
          getLog().warn({ err, appWorkflowsPath }, 'app_defaults_access_error');
          allErrors.push({
            filename: appWorkflowsPath,
            error: err.message,
            errorType: 'read_error',
          });
        } else {
          getLog().debug({ appWorkflowsPath }, 'app_defaults_directory_not_found');
        }
      }
    }
  }

  // 2. Load home-scoped workflows from ~/.archon/workflows/. No caller option —
  // discovery is responsible for surfacing home-scoped content everywhere.
  await maybeWarnLegacyHomePath();
  const homeWorkflowPath = roots.globalWorkflows;
  getLog().debug({ homeWorkflowPath }, 'searching_home_workflows');
  try {
    await access(homeWorkflowPath);
    const homeResult = mergeScopeResults(
      await loadWorkflowsFromDir(homeWorkflowPath),
      await loadPackagedWorkflowsFromDir(homeWorkflowPath, 'global')
    );
    for (const [filename, parsed] of homeResult.workflows) {
      if (workflowsByFile.has(filename)) {
        getLog().debug({ filename }, 'home_workflow_overrides_bundled');
      }
      workflowsByFile.set(filename, { ...parsed, source: 'global' });
    }
    allErrors.push(...homeResult.errors);
    getLog().info({ count: homeResult.workflows.size }, 'home_workflows_loaded');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      getLog().warn({ err, homeWorkflowPath }, 'home_workflows_access_error');
    } else {
      getLog().debug({ homeWorkflowPath }, 'home_workflows_not_found');
    }
  }

  // 3. Load from repo's workflow folder (overrides app defaults AND home scope by exact filename).
  // Skipped when cwd is null — surfaces bundled + home scopes only, which is the right answer
  // for callers without a project context (e.g. UI listing workflows before any codebase is registered).
  if (cwd === null) return finish('no_project_context');

  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(projectRoot ?? cwd, workflowFolder);

  getLog().debug({ workflowPath }, 'searching_repo_workflows');

  try {
    await access(workflowPath);
    const repoResult = mergeScopeResults(
      await loadWorkflowsFromDir(workflowPath),
      await loadPackagedWorkflowsFromDir(workflowPath, 'project')
    );

    // Repo workflows override bundled AND home scope by exact filename match.
    // Preserve 'bundled' source for workflows loaded from the defaults/ subdirectory
    // that were already registered as bundled in step 1.
    for (const [filename, parsed] of repoResult.workflows) {
      const existing = workflowsByFile.get(filename);
      if (existing?.source === 'bundled') {
        // This file was already loaded as a bundled default — the repo's defaults/
        // subdirectory is re-discovering it. Keep the bundled source label.
        getLog().debug({ filename }, 'repo_default_preserves_bundled_source');
        workflowsByFile.set(filename, { ...parsed, source: 'bundled' });
      } else {
        if (existing) {
          getLog().debug(
            { filename, overriddenSource: existing.source },
            'repo_workflow_overrides_lower_scope'
          );
        }
        workflowsByFile.set(filename, { ...parsed, source: 'project' });
      }
    }

    // Surface repo workflow errors to users (these are actionable)
    allErrors.push(...repoResult.errors);

    // Warn about deprecated non-prefixed defaults in repo's defaults folder
    const repoDefaultsPath = join(projectRoot ?? cwd, workflowFolder, 'defaults');
    try {
      await access(repoDefaultsPath);
      const defaultEntries = await readdir(repoDefaultsPath);
      const oldDefaults = defaultEntries.filter(
        f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('archon-')
      );
      if (oldDefaults.length > 0) {
        getLog().warn(
          { count: oldDefaults.length, repoDefaultsPath, hint: `rm -rf "${repoDefaultsPath}"` },
          'deprecated_workflow_defaults_found'
        );
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, repoDefaultsPath }, 'deprecated_defaults_check_failed');
      }
      // ENOENT (not found) is expected - no defaults folder exists
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw new Error(
        `Cannot access workflow folder at ${workflowPath}: ${err.message} (${err.code ?? 'unknown'})`
      );
    }
    getLog().debug({ workflowPath }, 'workflow_folder_not_found');
  }

  return finish();
}

/**
 * Discover workflows with config-aware default loading.
 *
 * Wraps discoverWorkflows with the standard pattern: try loadConfig to read
 * defaults.loadDefaultWorkflows, fall back to true on config load failure.
 * Logs config failures at warn level for observability.
 *
 * When `cwd` is `null` (no project context), `loadConfig` is not invoked and
 * `loadDefaults` keeps its initial value of `true`. The per-project opt-out
 * is a project-scoped setting; without a project there is no config to read.
 */
export async function discoverWorkflowsWithConfig(
  cwd: string | null,
  loadConfig: (cwd: string) => Promise<{
    defaults?: { loadDefaultWorkflows?: boolean; loadDefaultCommands?: boolean };
    commands?: { folder?: string };
  }>,
  /**
   * Where source is read from, when that is not `cwd`, and the settings that govern it.
   *
   * An executing run passes the roots of its frozen capture; every listing caller omits
   * this and keeps reading the working directory live. The settings ride ON the roots
   * because they decide what those roots mean — which command folder is searched, and
   * whether the bundled scope counts at all — and a resume must use the ones in force
   * when the capture was taken, not the target's.
   */
  sourceRoots?: WorkflowSourceRoots
): Promise<WorkflowLoadResult> {
  const sourceConfig = sourceRoots && workflowSourceConfigForRoots(sourceRoots);
  let loadDefaults = sourceConfig?.load_default_workflows ?? true;
  // Command-scan parity: pass the repo's configured command folder + loadDefaultCommands
  // opt-out through so the include safety scan resolves the same command files the
  // runtime/validator would (else it silently degrades to WARN on custom-folder repos).
  let commandFolder = sourceConfig?.command_folder;
  let loadDefaultCommands = sourceConfig?.load_default_commands;
  if (cwd !== null && sourceConfig === undefined) {
    try {
      const cfg = await loadConfig(cwd);
      loadDefaults = cfg.defaults?.loadDefaultWorkflows ?? true;
      commandFolder = cfg.commands?.folder;
      loadDefaultCommands = cfg.defaults?.loadDefaultCommands;
    } catch (error) {
      getLog().warn(
        { err: error as Error, cwd },
        'config_load_failed_using_default_workflow_discovery'
      );
    }
  }
  return discoverWorkflows(cwd, { loadDefaults, commandFolder, loadDefaultCommands, sourceRoots });
}
