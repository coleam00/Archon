/**
 * Workflow discovery - finds and loads workflow YAML files from disk.
 *
 * Extracted from loader.ts so that file can focus on YAML parsing.
 * This module handles directory traversal, bundled defaults, and the
 * full discoverWorkflows entry point.
 *
 * Imports parseWorkflow from loader.ts (parsing concern stays there).
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  WorkflowLoadResult,
  WorkflowWithSource,
} from './schemas';
import * as archonPaths from '@harneeslab/paths';
import { BUNDLED_WORKFLOWS, isBinaryBuild } from './defaults/bundled-defaults';
import { createLogger } from '@harneeslab/paths';
import { parseWorkflow } from './loader';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.discovery');
  return cachedLog;
}

interface DirLoadResult {
  workflows: Map<string, WorkflowDefinition>;
  errors: WorkflowLoadError[];
}

/**
 * Load workflows from a directory (recursively includes subdirectories).
 * Failures are per-file: one broken file does not abort loading the rest.
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<DirLoadResult> {
  const workflows = new Map<string, WorkflowDefinition>();
  const errors: WorkflowLoadError[] = [];

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);

      try {
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          // Recursively load from subdirectories
          const subResult = await loadWorkflowsFromDir(entryPath);
          for (const [filename, workflow] of subResult.workflows) {
            workflows.set(filename, workflow);
          }
          errors.push(...subResult.errors);
        } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          const content = await readFile(entryPath, 'utf-8');
          const result = parseWorkflow(content, entry);

          if (result.workflow) {
            workflows.set(entry, result.workflow);
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

/**
 * Load bundled default workflows (for binary distribution)
 * Returns a Map of filename -> workflow for consistency with loadWorkflowsFromDir
 *
 * Note: Bundled workflows are embedded at compile time and should ALWAYS be valid.
 * Parse failures indicate a build-time corruption and are logged as errors.
 */
function loadBundledWorkflows(): DirLoadResult {
  const workflows = new Map<string, WorkflowDefinition>();
  const errors: WorkflowLoadError[] = [];

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const filename = `${name}.yaml`;
    const result = parseWorkflow(content, filename);
    if (result.workflow) {
      workflows.set(filename, result.workflow);
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
 * Discover and load workflows from codebase
 * Loads from both app's bundled defaults and repo's workflow folder.
 * Repo workflows override app defaults by exact filename match.
 *
 * When running as a compiled binary, defaults are loaded from the bundled
 * content embedded at compile time. When running with Bun, defaults are
 * loaded from the filesystem.
 */
export async function discoverWorkflows(
  cwd: string,
  options?: { globalSearchPath?: string; loadDefaults?: boolean }
): Promise<WorkflowLoadResult> {
  // Map of filename -> workflow+source for deduplication
  const workflowsByFile = new Map<string, WorkflowWithSource>();
  const allErrors: WorkflowLoadError[] = [];

  // 1. Load from app's bundled defaults (unless opted out)
  const loadDefaultWorkflows = options?.loadDefaults !== false;
  if (loadDefaultWorkflows) {
    if (isBinaryBuild()) {
      // Binary: load from embedded bundled content
      getLog().debug('loading_bundled_default_workflows');
      const bundledResult = loadBundledWorkflows();
      for (const [filename, workflow] of bundledResult.workflows) {
        workflowsByFile.set(filename, { workflow, source: 'bundled' });
      }
      allErrors.push(...bundledResult.errors);
      getLog().info({ count: bundledResult.workflows.size }, 'bundled_default_workflows_loaded');
    } else {
      // Bun: load from filesystem (development mode)
      const appDefaultsPath = archonPaths.getDefaultWorkflowsPath();
      getLog().debug({ appDefaultsPath }, 'loading_app_default_workflows');
      try {
        await access(appDefaultsPath);
        const appResult = await loadWorkflowsFromDir(appDefaultsPath);
        for (const [filename, workflow] of appResult.workflows) {
          workflowsByFile.set(filename, { workflow, source: 'bundled' });
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
          getLog().warn({ err, appDefaultsPath }, 'app_defaults_access_error');
        } else {
          getLog().debug({ appDefaultsPath }, 'app_defaults_directory_not_found');
        }
      }
    }
  }

  // 2. Load from global search path (e.g., ~/.archon/.archon/workflows/ for orchestrator)
  if (options?.globalSearchPath) {
    const [globalWorkflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
    const globalWorkflowPath = join(options.globalSearchPath, globalWorkflowFolder);
    getLog().debug({ globalWorkflowPath }, 'searching_global_workflows');
    try {
      await access(globalWorkflowPath);
      const globalResult = await loadWorkflowsFromDir(globalWorkflowPath);
      for (const [filename, workflow] of globalResult.workflows) {
        if (workflowsByFile.has(filename)) {
          getLog().debug({ filename }, 'global_workflow_overrides_default');
        }
        // NOTE: Global workflows (~/.archon/.archon/workflows/) are classified as 'project'
        // rather than a separate 'global' source. This is an intentional scope decision for
        // the initial source badge feature — a 'global' source variant can be added later.
        workflowsByFile.set(filename, { workflow, source: 'project' });
      }
      allErrors.push(...globalResult.errors);
      getLog().info({ count: globalResult.workflows.size }, 'global_workflows_loaded');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, globalWorkflowPath }, 'global_workflows_access_error');
      } else {
        getLog().debug({ globalWorkflowPath }, 'global_workflows_not_found');
      }
    }
  }

  // 3. Load from repo's workflow folder (overrides app defaults by exact filename)
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

  getLog().debug({ workflowPath }, 'searching_repo_workflows');

  try {
    await access(workflowPath);
    const repoResult = await loadWorkflowsFromDir(workflowPath);

    // Repo workflows override app defaults by exact filename match.
    // Preserve 'bundled' source for workflows loaded from the defaults/ subdirectory
    // that were already registered as bundled in step 1.
    for (const [filename, workflow] of repoResult.workflows) {
      const existing = workflowsByFile.get(filename);
      if (existing?.source === 'bundled') {
        // This file was already loaded as a bundled default — the repo's defaults/
        // subdirectory is re-discovering it. Keep the bundled source label.
        getLog().debug({ filename }, 'repo_default_preserves_bundled_source');
        workflowsByFile.set(filename, { workflow, source: 'bundled' });
      } else {
        if (existing) {
          getLog().debug({ filename }, 'repo_workflow_overrides_default');
        }
        workflowsByFile.set(filename, { workflow, source: 'project' });
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

  const workflows = Array.from(workflowsByFile.values());
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
 */
export async function discoverWorkflowsWithConfig(
  cwd: string,
  loadConfig: (cwd: string) => Promise<{ defaults?: { loadDefaultWorkflows?: boolean } }>,
  options?: { globalSearchPath?: string }
): Promise<WorkflowLoadResult> {
  let loadDefaults = true;
  try {
    const cfg = await loadConfig(cwd);
    loadDefaults = cfg.defaults?.loadDefaultWorkflows ?? true;
  } catch (error) {
    getLog().warn(
      { err: error as Error, cwd },
      'config_load_failed_using_default_workflow_discovery'
    );
  }
  return discoverWorkflows(cwd, { ...options, loadDefaults });
}
