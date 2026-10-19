import { readdir, access } from 'fs/promises';
import { basename, join } from 'path';
import * as archonPaths from '@archon/paths';
import type { WorkflowLoadError } from '../schemas';
import {
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOW_PATHS,
  isBinaryBuild,
} from '../defaults/bundled-defaults';
import { collectInstalledBundleSources, readBundleContent } from '../defaults/bundle-inventory';
import { parseWorkflow } from '../loader';
import { qualifyWorkflowResources } from '../packaged-workflow';
import type { DiscoveryContext } from './context';
import {
  isYamlFile,
  loadPackagedWorkflowsFromDir,
  loadScopeDirectory,
  loadWorkflowsFromDir,
  mergeScopeResults,
  type DirLoadResult,
  type ParsedWorkflowFile,
  type ScopeFile,
  type WorkflowParseContext,
} from './load-dir';
import { getLog } from './log';

/** Workflows by filename; a higher scope's file replaces a lower scope's of the same name. */
export type ScopeFiles = Map<string, ScopeFile>;

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

function accessError(filename: string, error: unknown): WorkflowLoadError {
  return {
    filename,
    error: (error as NodeJS.ErrnoException).message,
    errorType: 'read_error',
    cause: error,
  };
}

/**
 * Bundled defaults. A captured run loads the bundled workflows IT froze — including in a
 * binary, where the capture wrote the embedded constants out as files. That is what lets
 * a paused run resume across an upgrade instead of failing on unverifiable bundled bytes.
 */
export async function loadBundledScope(
  context: DiscoveryContext,
  files: ScopeFiles
): Promise<void> {
  if (isBinaryBuild() && context.roots.kind === 'live') {
    getLog().debug('loading_bundled_default_workflows');
    const bundledResult = loadEmbeddedWorkflows(context);
    for (const [filename, parsed] of bundledResult.workflows) {
      files.set(filename, { ...parsed, source: 'bundled' });
    }
    context.allErrors.push(...bundledResult.errors);
    getLog().info({ count: bundledResult.workflows.size }, 'bundled_default_workflows_loaded');
    return;
  }

  // Bun: load from filesystem (development mode)
  const appWorkflowsPath = context.roots.bundledWorkflows;
  getLog().debug({ appWorkflowsPath }, 'loading_app_default_workflows');
  try {
    const appResult =
      context.roots.kind === 'live'
        ? await loadLiveBundle(context, appWorkflowsPath)
        : await loadCapturedBundle(context, appWorkflowsPath);
    for (const [filename, parsed] of appResult.workflows) {
      files.set(filename, { ...parsed, source: 'bundled' });
    }
    if (appResult.errors.length > 0) {
      getLog().warn(
        { errorCount: appResult.errors.length, errors: appResult.errors },
        'app_default_workflow_errors'
      );
      context.allErrors.push(...appResult.errors);
    }
    getLog().info({ count: appResult.workflows.size }, 'app_default_workflows_loaded');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (context.roots.kind === 'live' || err.code !== 'ENOENT') {
      getLog().warn({ err, appWorkflowsPath }, 'app_defaults_access_error');
      context.allErrors.push(accessError(appWorkflowsPath, error));
    } else {
      getLog().debug({ appWorkflowsPath }, 'app_defaults_directory_not_found');
    }
  }
}

/**
 * Load bundled default workflows (for binary distribution).
 *
 * Note: Bundled workflows are embedded at compile time and should ALWAYS be valid.
 * Parse failures indicate a build-time corruption and are logged as errors.
 */
function loadEmbeddedWorkflows(context: WorkflowParseContext): DirLoadResult {
  const workflows = new Map<string, ParsedWorkflowFile>();
  const errors: WorkflowLoadError[] = [];

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const path = BUNDLED_WORKFLOW_PATHS[name];
    if (path === undefined) throw new Error(`Bundled workflow "${name}" has no source path.`);
    const filename = basename(path);
    const result = parseWorkflow(content, filename, context.providers, context.configuredEnvNames);
    if (!result.workflow) {
      // Bundled workflows should ALWAYS be valid - this indicates a build-time error
      getLog().error(
        { filename, contentPreview: content.slice(0, 200) + '...' },
        'bundled_workflow_parse_failed'
      );
      errors.push(result.error);
      continue;
    }
    const owner = BUNDLED_WORKFLOW_OWNERS[name];
    if (owner !== undefined) {
      qualifyWorkflowResources(result.workflow, { source: 'bundled', ...owner });
    }
    workflows.set(filename, { workflow: result.workflow, parseWarnings: result.warnings });
    getLog().debug({ workflowName: result.workflow.name }, 'bundled_workflow_loaded');
  }

  return { workflows, errors };
}

/** The packs this build ships, read from the app's workflow folder in source mode. */
async function loadLiveBundle(
  context: WorkflowParseContext,
  appWorkflowsPath: string
): Promise<DirLoadResult> {
  const result: DirLoadResult = { workflows: new Map(), errors: [] };
  const sources = (await collectInstalledBundleSources(appWorkflowsPath)) ?? [];
  for (const file of sources) {
    if (file.kind !== 'workflow') continue;
    const filename = basename(file.sourcePath);
    const parsed = parseWorkflow(
      await readBundleContent(file),
      filename,
      context.providers,
      context.configuredEnvNames
    );
    if (!parsed.workflow) {
      result.errors.push(parsed.error);
      continue;
    }
    qualifyWorkflowResources(parsed.workflow, { source: 'bundled', ...file.owner });
    result.workflows.set(filename, { workflow: parsed.workflow, parseWarnings: parsed.warnings });
  }
  return result;
}

/** A capture's inventory belongs to that run, including packs no longer shipped. */
async function loadCapturedBundle(
  context: WorkflowParseContext,
  appWorkflowsPath: string
): Promise<DirLoadResult> {
  await access(appWorkflowsPath);
  // A capture taken by a build that still shipped flat defaults holds them here.
  const appDefaultsPath = join(appWorkflowsPath, 'defaults');
  return mergeScopeResults(
    await loadWorkflowsFromDir(context, appDefaultsPath),
    await loadPackagedWorkflowsFromDir(context, appWorkflowsPath, 'bundled')
  );
}

/**
 * Home-scoped workflows from `~/.archon/workflows/`. No caller option — discovery is
 * responsible for surfacing home-scoped content everywhere.
 */
export async function loadGlobalScope(context: DiscoveryContext, files: ScopeFiles): Promise<void> {
  await maybeWarnLegacyHomePath();
  const homeWorkflowPath = context.roots.globalWorkflows;
  getLog().debug({ homeWorkflowPath }, 'searching_home_workflows');
  try {
    await access(homeWorkflowPath);
    const homeResult = await loadScopeDirectory(
      context,
      homeWorkflowPath,
      homeWorkflowPath,
      'global'
    );
    for (const [filename, parsed] of homeResult.workflows) {
      if (files.has(filename)) {
        getLog().debug({ filename }, 'home_workflow_overrides_bundled');
      }
      files.set(filename, { ...parsed, source: 'global' });
    }
    context.allErrors.push(...homeResult.errors);
    getLog().info({ count: homeResult.workflows.size }, 'home_workflows_loaded');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      getLog().warn({ err, homeWorkflowPath }, 'home_workflows_access_error');
      context.allErrors.push(accessError(homeWorkflowPath, error));
    } else {
      getLog().debug({ homeWorkflowPath }, 'home_workflows_not_found');
    }
  }
}

/**
 * The repo's workflow folder, which overrides bundled and home scope by exact filename.
 * A missing folder is no project workflows; any other access failure rejects discovery.
 */
export async function loadProjectScope(
  context: DiscoveryContext,
  cwd: string,
  files: ScopeFiles
): Promise<void> {
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(context.roots.project ?? cwd, workflowFolder);
  getLog().debug({ workflowPath }, 'searching_repo_workflows');

  try {
    await access(workflowPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
    getLog().debug({ workflowPath }, 'workflow_folder_not_found');
    return;
  }
  const repoResult = await loadScopeDirectory(context, workflowPath, workflowPath, 'project');

  // Repo workflows override bundled AND home scope by exact filename match.
  // Preserve 'bundled' source for workflows loaded from the defaults/ subdirectory
  // that were already registered as bundled in step 1.
  for (const [filename, parsed] of repoResult.workflows) {
    const existing = files.get(filename);
    if (existing?.source === 'bundled') {
      // This file was already loaded as a bundled default — the repo's defaults/
      // subdirectory is re-discovering it. Keep the bundled source label.
      getLog().debug({ filename }, 'repo_default_preserves_bundled_source');
      files.set(filename, { ...parsed, source: 'bundled' });
      continue;
    }
    if (existing) {
      getLog().debug(
        { filename, overriddenSource: existing.source },
        'repo_workflow_overrides_lower_scope'
      );
    }
    files.set(filename, { ...parsed, source: 'project' });
  }

  // Surface repo workflow errors to users (these are actionable)
  context.allErrors.push(...repoResult.errors);
  await warnDeprecatedRepoDefaults(join(workflowPath, 'defaults'));
}

/** Warn about deprecated non-prefixed defaults in the repo's defaults folder. */
async function warnDeprecatedRepoDefaults(repoDefaultsPath: string): Promise<void> {
  try {
    await access(repoDefaultsPath);
    const defaultEntries = await readdir(repoDefaultsPath);
    const oldDefaults = defaultEntries.filter(f => isYamlFile(f) && !f.startsWith('archon-'));
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
}
