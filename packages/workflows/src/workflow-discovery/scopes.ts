import { readdir, access } from 'fs/promises';
import { basename, join } from 'path';
import * as archonPaths from '@archon/paths';
import type { WorkflowLoadError } from '../schemas';
import {
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOW_PATHS,
  isBinaryBuild,
  type BundledWorkflowOwner,
} from '../defaults/bundled-defaults';
import { collectInstalledBundleSources, readBundleContent } from '../defaults/bundle-inventory';
import { parseWorkflow, type ParseResult } from '../loader';
import { PACK_DECLARATION_PATH, qualifyWorkflowResources } from '../packaged-workflow';
import { PackSettingsError, parsePackDeclaration, type PackDeclaration } from '../pack-settings';
import type { DiscoveryContext } from './context';
import {
  addPackToScope,
  loadPackagedWorkflowsFromDir,
  loadScopeDirectory,
  loadWorkflowsFromDir,
  mergeScopeResults,
  type DirLoadResult,
  type ParsedWorkflowFile,
  type ScopeFile,
  type WorkflowParseContext,
} from './load-dir';
import { isYamlFile } from './pack-layout';
import {
  AmbiguousSourcePackError,
  sourcePackFolder,
  type SourcePackFolder,
} from '../workflow-source/source-pack';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import { getLog } from './log';

/** Workflows by filename; a higher scope's file replaces a lower scope's of the same name. */
export type ScopeFiles = Map<string, ScopeFile>;

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
        {
          errorCount: appResult.errors.length,
          errors: appResult.errors.map(({ filename, errorType }) => ({ filename, errorType })),
        },
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
 * Parse one bundled workflow. A packaged one gets its pack, with the settings that
 * `declaration` (the pack's `.pack/pack.yaml` text, undefined when it ships none) declares.
 * An invalid declaration fails every workflow of the pack, as it does for a pack folder.
 */
function parseBundledWorkflow(
  context: WorkflowParseContext,
  content: string,
  filename: string,
  owner: BundledWorkflowOwner | undefined,
  declaration: string | undefined
): ParseResult {
  const { providers, configuredEnvNames } = context;
  if (owner === undefined) return parseWorkflow(content, filename, providers, configuredEnvNames);
  let declared: PackDeclaration;
  try {
    declared =
      declaration === undefined
        ? {}
        : parsePackDeclaration(declaration, `${owner.pack}/${PACK_DECLARATION_PATH}`);
  } catch (error) {
    if (!(error instanceof PackSettingsError)) throw error;
    return {
      workflow: null,
      error: { filename, error: error.message, errorType: 'validation_error' },
    };
  }
  return parseWorkflow(content, filename, providers, configuredEnvNames, {
    key: owner.pack,
    source: 'bundled',
    ...declared,
  });
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
    const owner = BUNDLED_WORKFLOW_OWNERS[name];
    const declaration =
      owner === undefined
        ? undefined
        : BUNDLED_SCRIPT_PACKS[owner.pack]?.files[PACK_DECLARATION_PATH];
    const result = parseBundledWorkflow(context, content, filename, owner, declaration);
    if (!result.workflow) {
      // Bundled workflows should ALWAYS be valid - this indicates a build-time error
      getLog().error({ filename }, 'bundled_workflow_parse_failed');
      errors.push(result.error);
      continue;
    }
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
  const declarations = new Map<string, string>();
  for (const file of sources) {
    if (file.kind === 'pack-file' && file.packPath === PACK_DECLARATION_PATH) {
      declarations.set(file.pack, await readBundleContent(file));
    }
  }
  for (const file of sources) {
    if (file.kind !== 'workflow') continue;
    const filename = basename(file.sourcePath);
    const parsed = parseBundledWorkflow(
      context,
      await readBundleContent(file),
      filename,
      file.owner,
      declarations.get(file.owner.pack)
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
 *
 * A live source that is itself a pack folder (`sourcePackFolder`) adds that pack to the
 * project scope under its manifest name. A capture already holds it under
 * `project/.archon/workflows/<name>`, so captured roots read only the folder.
 */
export async function loadProjectScope(
  context: DiscoveryContext,
  cwd: string,
  files: ScopeFiles
): Promise<void> {
  const projectRoot = context.roots.project ?? cwd;
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(projectRoot, workflowFolder);
  getLog().debug({ workflowPath }, 'searching_repo_workflows');

  const repoResult = await loadRepoWorkflows(context, workflowPath);
  if (context.roots.kind === 'live') await addSourcePack(context, projectRoot, repoResult);

  // Repo workflows override bundled AND home scope by exact filename match. A file read
  // from here is `project`, even when its name matches a bundled one: `--workflow-source`
  // admission and dispatch provenance trust this label to say where the bytes came from.
  for (const [filename, parsed] of repoResult.workflows) {
    const existing = files.get(filename);
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

async function loadRepoWorkflows(
  context: DiscoveryContext,
  workflowPath: string
): Promise<DirLoadResult> {
  try {
    await access(workflowPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
    getLog().debug({ workflowPath }, 'workflow_folder_not_found');
    return { workflows: new Map(), errors: [] };
  }
  return loadScopeDirectory(context, workflowPath, workflowPath, 'project');
}

/**
 * Merge the pack the source folder is into the project scope's files. A pack folder that
 * cannot be read, or that also holds a nested copy of itself, is a load error, and no
 * workflow of that pack loads from either copy.
 */
async function addSourcePack(
  context: DiscoveryContext,
  projectRoot: string,
  into: DirLoadResult
): Promise<void> {
  let pack: SourcePackFolder | null;
  try {
    pack = await sourcePackFolder(projectRoot);
  } catch (error) {
    into.errors.push({
      filename: join(projectRoot, PLUGIN_MANIFEST_FILE),
      error: (error as Error).message,
      errorType: 'read_error',
      cause: error,
    });
    if (error instanceof AmbiguousSourcePackError) {
      for (const [filename, parsed] of into.workflows) {
        if (parsed.workflow.pack?.key === error.packName) into.workflows.delete(filename);
      }
    }
    return;
  }
  if (pack === null) return;
  getLog().debug({ pack: pack.name, packDir: pack.dir }, 'source_pack_folder_found');
  const packaged: DirLoadResult = { workflows: new Map(), errors: [] };
  await addPackToScope(context, packaged, new Set(), {
    name: pack.name,
    path: pack.dir,
    source: 'project',
  });
  mergeScopeResults(into, packaged);
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
