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
 *   1. `bundled` — embedded in the Archon binary (or read from the app's
 *      defaults folder in source mode).
 *   2. `global`  — home-scoped at `~/.archon/workflows/`. Applies to every
 *      repo; discovered automatically (no caller option needed).
 *   3. `project` — repo-local at `<cwd>/.archon/workflows/`.
 *
 * Same-named files at a higher scope override those at lower scopes.
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  WorkflowLoadResult,
  WorkflowWithSource,
  WorkflowSource,
  DeclaredWorkflowConfig,
} from './schemas';
import { isIncludeNode } from './schemas';
import * as archonPaths from '@archon/paths';
import {
  BUNDLED_WORKFLOWS,
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOW_OWNERS,
  isBinaryBuild,
} from './defaults/bundled-defaults';
import { createLogger } from '@archon/paths';
import { isValidCommandName, MAX_DISCOVERY_DEPTH } from './command-validation';
import { parseWorkflow } from './loader';
import { expandWorkflowIncludes } from './include-expander';
import { collectFileBackedCommandNames } from './command-file';
import {
  getPackagedResourceDirectory,
  isValidWorkflowFolderSegment,
  parsePackagedResourceReference,
  qualifyWorkflowResources,
} from './packaged-workflow';
import type { IncludeCommandContent } from './compiled-command';

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
// `.archon/workflows/defaults/foo.yaml`) is imported from `command-validation`,
// the dependency-free leaf module, so the loader here and the workflow-name
// validator there share one source of truth and cannot drift apart. We stop at
// one level deliberately — deeper nesting has never been part of the documented
// convention and adds only routing ambiguity.

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
          // Only descend if we're still within the depth cap. Past the cap,
          // subdirectories are ignored (same convention as the paths-package
          // `findMarkdownFilesRecursive` depth cap).
          if (depth >= MAX_DISCOVERY_DEPTH) continue;
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
    if (!isValidWorkflowFolderSegment(pack)) {
      errors.push({
        filename: pack,
        error: `Invalid packaged workflow pack directory '${pack}'.`,
        errorType: 'validation_error',
      });
      continue;
    }

    let workflowFolders: string[];
    try {
      workflowFolders = await readdir(packPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      errors.push({
        filename: pack,
        error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
        errorType: 'read_error',
      });
      continue;
    }
    for (const workflowFolder of workflowFolders.sort((a, b) => a.localeCompare(b))) {
      const workflowPath = join(packPath, workflowFolder);
      try {
        if (!(await stat(workflowPath)).isDirectory()) continue;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, workflowPath }, 'packaged_workflow_path_read_error');
          errors.push({
            filename: `${pack}/${workflowFolder}`,
            error: `Path read error: ${err.message} (${err.code ?? 'unknown'})`,
            errorType: 'read_error',
          });
        }
        continue;
      }
      if (!isValidWorkflowFolderSegment(workflowFolder)) {
        errors.push({
          filename: `${pack}/${workflowFolder}`,
          error: `Invalid packaged workflow directory '${pack}/${workflowFolder}'.`,
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
          filename: `${pack}/${workflowFolder}`,
          error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
        continue;
      }
      const yamlFiles = workflowEntries
        .filter(entry => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort((a, b) => a.localeCompare(b));
      if (yamlFiles.length !== 1) {
        errors.push({
          filename: `${pack}/${workflowFolder}`,
          error: `Packaged workflow '${pack}/${workflowFolder}' must contain exactly one .yaml or .yml file (found ${yamlFiles.length}).`,
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
          filename: `${pack}/${workflowFolder}/${filename}`,
          error: `File read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
        continue;
      }
      const parsed = parseWorkflow(content, filename);
      if (!parsed.workflow) {
        errors.push(parsed.error);
        continue;
      }
      qualifyWorkflowResources(parsed.workflow, { source, pack, workflow: workflowFolder });

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
      workflows.set(filename, { workflow: parsed.workflow, parseWarnings: parsed.warnings });
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
    const filename = `${name}.yaml`;
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
 * bundled defaults, unless `loadDefaultCommands` is false). Returns `null` when no candidate
 * resolves, and a path-bearing error when a higher-precedence scope cannot be inspected or a
 * matched candidate cannot be read. Read-only; used so the include expander can compile a
 * block's command body while proving its lexical reference boundary.
 */
async function resolveCommandContentForScan(
  cwd: string | null,
  commandName: string,
  config: CommandScanConfig
): Promise<IncludeCommandContent> {
  if (!isValidCommandName(commandName)) return null;

  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) {
    if (packaged.owner.source === 'bundled') {
      if (config.loadDefaultCommands === false) return null;
      if (isBinaryBuild()) return BUNDLED_COMMANDS[commandName] ?? null;
    }

    let workflowsRoot: string;
    if (packaged.owner.source === 'project') {
      if (cwd === null) return null;
      workflowsRoot = join(cwd, '.archon', 'workflows');
    } else if (packaged.owner.source === 'global') {
      workflowsRoot = archonPaths.getHomeWorkflowsPath();
    } else {
      workflowsRoot = dirname(archonPaths.getDefaultWorkflowsPath());
    }
    const commandPath = join(
      getPackagedResourceDirectory(workflowsRoot, packaged.owner, 'commands'),
      `${packaged.name}.md`
    );
    try {
      return await readFile(commandPath, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      return { path: commandPath, message: err.message, operation: 'read' };
    }
  }

  const dirs: string[] = [];
  if (cwd !== null) {
    // Pass the configured folder so a repo with a custom command directory is scanned
    // (not silently skipped → downgraded to WARN). Matches getCommandFolderSearchPaths use
    // in the validator/executor.
    for (const folder of archonPaths.getCommandFolderSearchPaths(config.commandFolder)) {
      dirs.push(join(cwd, folder));
    }
  }
  dirs.push(archonPaths.getHomeCommandsPath());

  for (const dir of dirs) {
    let entries: Awaited<ReturnType<typeof archonPaths.findMarkdownFilesRecursive>>;
    try {
      entries = await archonPaths.findMarkdownFilesRecursive(dir, '', { maxDepth: 1 });
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

  // Bundled defaults — skipped when the repo opts out (loadDefaultCommands: false), matching
  // the workflow/command discovery opt-out so the scan doesn't resolve a command the repo
  // has disabled.
  if (config.loadDefaultCommands === false) return null;
  if (isBinaryBuild()) {
    return BUNDLED_COMMANDS[commandName] ?? null;
  }
  const defaultsDir = archonPaths.getDefaultCommandsPath();
  let entries: Awaited<ReturnType<typeof archonPaths.findMarkdownFilesRecursive>>;
  try {
    entries = await archonPaths.findMarkdownFilesRecursive(defaultsDir, '', { maxDepth: 1 });
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
  cwd: string | null,
  byName: ReadonlyMap<string, WorkflowDefinition>,
  config: CommandScanConfig
): Promise<Map<string, IncludeCommandContent>> {
  const targetNames = new Set<string>();
  const visit = (workflow: WorkflowDefinition): void => {
    for (const node of workflow.nodes) {
      if (isIncludeNode(node) && !targetNames.has(node.include)) {
        targetNames.add(node.include);
        const target = byName.get(node.include);
        if (target) visit(target);
      }
    }
  };
  for (const workflow of byName.values()) visit(workflow);

  const contents = new Map<string, IncludeCommandContent>();
  if (targetNames.size === 0) return contents; // no includes → nothing to scan
  for (const name of targetNames) {
    const workflow = byName.get(name);
    if (!workflow) continue;
    for (const commandName of collectFileBackedCommandNames(workflow.nodes)) {
      if (!contents.has(commandName)) {
        contents.set(commandName, await resolveCommandContentForScan(cwd, commandName, config));
      }
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
  options?: { loadDefaults?: boolean; commandFolder?: string; loadDefaultCommands?: boolean }
): Promise<WorkflowLoadResult> {
  // Map of filename -> workflow + source + parse warnings, for deduplication.
  // A later scope's `set()` replaces all three together, so a clean project file
  // can never inherit the bundled file's warnings (see ParsedWorkflowFile).
  const workflowsByFile = new Map<string, ParsedWorkflowFile & { source: WorkflowSource }>();
  const allErrors: WorkflowLoadError[] = [];

  /**
   * Final discovery step: inline every `include:` node (see include-expander.ts).
   * Resolves include targets against the full name map (bundled < global < project
   * precedence already applied to `workflowsByFile`), then swaps each workflow for
   * its flattened, namespaced form. A workflow that fails to expand is dropped and
   * its error surfaced via `allErrors`. Only `.workflow` changes — `source` is kept.
   */
  const expandIncludes = async (): Promise<WorkflowWithSource[]> => {
    // Overrides are by FILENAME, but include targets resolve by workflow NAME. Two
    // surviving files (after filename-precedence) declaring the same `name:` would
    // silently collapse in the name map — last-writer-wins, emitting the same expanded
    // workflow under both filenames with the wrong source label and making include
    // resolution order-dependent. Detect the collision and error the offending files
    // instead (resilient: drop only the colliding entries, keep discovering the rest).
    // Same-name shadowing was already ambiguous before `include:`; the name map just made
    // it load-bearing, so this hardens a pre-existing gap.
    const filenamesByName = new Map<string, string[]>();
    for (const [filename, { workflow }] of workflowsByFile) {
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
    for (const [filename, { workflow }] of workflowsByFile) {
      if (duplicateNames.has(workflow.name)) continue; // ambiguous — errored above, excluded
      rawByName.set(workflow.name, workflow);
      if (!filenameByName.has(workflow.name)) filenameByName.set(workflow.name, filename);
    }
    // Pre-resolve command-file contents for include-target command nodes so the expander
    // can catch a block command file that references a sibling id namespacing renames.
    const commandContents = await resolveIncludeBlockCommandContents(cwd, rawByName, {
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
    for (const { workflow, source, parseWarnings } of workflowsByFile.values()) {
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
      result.push({
        workflow: expanded,
        source,
        // Omitted rather than empty, matching the `errors` field on the same
        // surfaces: presence alone is the signal.
        ...(parseWarnings && parseWarnings.length > 0 ? { parseWarnings } : {}),
        ...(Object.keys(declared).length > 0 ? { declared } : {}),
      });
    }
    return result;
  };

  // 1. Load from app's bundled defaults (unless opted out)
  const loadDefaultWorkflows = options?.loadDefaults !== false;
  if (loadDefaultWorkflows) {
    if (isBinaryBuild()) {
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
      const appDefaultsPath = archonPaths.getDefaultWorkflowsPath();
      const appWorkflowsPath = dirname(appDefaultsPath);
      getLog().debug({ appWorkflowsPath }, 'loading_app_default_workflows');
      try {
        await access(appWorkflowsPath);
        const appResult = mergeScopeResults(
          await loadWorkflowsFromDir(appDefaultsPath),
          await loadPackagedWorkflowsFromDir(appWorkflowsPath, 'bundled')
        );
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
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, appWorkflowsPath }, 'app_defaults_access_error');
        } else {
          getLog().debug({ appWorkflowsPath }, 'app_defaults_directory_not_found');
        }
      }
    }
  }

  // 2. Load home-scoped workflows from ~/.archon/workflows/. No caller option —
  // discovery is responsible for surfacing home-scoped content everywhere.
  await maybeWarnLegacyHomePath();
  const homeWorkflowPath = archonPaths.getHomeWorkflowsPath();
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
  if (cwd === null) {
    const workflows = await expandIncludes();
    getLog().info(
      { count: workflows.length, errorCount: allErrors.length, scope: 'no_project_context' },
      'workflows_discovery_completed'
    );
    return { workflows, errors: allErrors };
  }

  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

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
    const repoDefaultsPath = join(cwd, workflowFolder, 'defaults');
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

  const workflows = await expandIncludes();
  getLog().info(
    { count: workflows.length, errorCount: allErrors.length },
    'workflows_discovery_completed'
  );
  return { workflows, errors: allErrors };
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
  }>
): Promise<WorkflowLoadResult> {
  let loadDefaults = true;
  // Command-scan parity: pass the repo's configured command folder + loadDefaultCommands
  // opt-out through so the include safety scan resolves the same command files the
  // runtime/validator would (else it silently degrades to WARN on custom-folder repos).
  let commandFolder: string | undefined;
  let loadDefaultCommands: boolean | undefined;
  if (cwd !== null) {
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
  return discoverWorkflows(cwd, { loadDefaults, commandFolder, loadDefaultCommands });
}
