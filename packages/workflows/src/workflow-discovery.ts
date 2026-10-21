/**
 * Workflow discovery - finds and loads workflow YAML files from disk.
 *
 * This module is the discoverWorkflows entry point. Each scope's loading lives in
 * `workflow-discovery/`: directory traversal in `load-dir.ts`, the scopes below in
 * `scopes.ts`, installed packs in `installed.ts`, and include expansion of a scope in
 * `expand-scope.ts`. Parsing one file stays in loader.ts.
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
 * Installed workflow packs (`archon plugin add`) are a fourth source outside that
 * precedence: each pack resolves its includes within itself, and only its manifest
 * entrypoints are dispatchable, as `owner/plugin:<entrypoint>`.
 */
import { type ProviderRegistry } from '@archon/provider-contract';
import type { WorkflowLoadResult } from './schemas';
import * as archonPaths from '@archon/paths';
import {
  WorkflowSourceUnavailableError,
  assertCapturedFilesPresent,
  isSourceReadFailure,
  liveSourceRoots,
  loadWorkflowSource,
  workflowSourceConfigForRoots,
  type WorkflowSourceRoots,
} from './workflow-source';
import type { DiscoveryContext } from './workflow-discovery/context';
import { expandScope } from './workflow-discovery/expand-scope';
import { discoverInstalled } from './workflow-discovery/installed';
import {
  loadBundledScope,
  loadGlobalScope,
  loadProjectScope,
  type ScopeFiles,
} from './workflow-discovery/scopes';
import { getLog } from './workflow-discovery/log';
// Re-exported here because this is the module callers already import to discover with.
export { liveSourceRoots } from './workflow-source';
export type { WorkflowSourceRoots } from './workflow-source';

export { isValidWorkflowFolderSegment } from './packaged-workflow';

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
 */
export async function discoverWorkflows(
  cwd: string | null,
  options: {
    providers: ProviderRegistry;
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
    /**
     * Names (never values) from `.archon/config.yaml`'s `env:` section, threaded from
     * `discoverWorkflowsWithConfig` — live or from a frozen capture's recorded source
     * config.
     */
    envVarNames?: readonly string[];
  }
): Promise<WorkflowLoadResult> {
  const roots = options.sourceRoots ?? liveSourceRoots(cwd);
  const context: DiscoveryContext = {
    cwd,
    roots,
    providers: options.providers,
    capture:
      roots.kind === 'captured'
        ? await loadWorkflowSource(roots.anchor.root, roots.anchor.digest, roots.anchor.config)
        : undefined,
    // Names the exec env-read checker treats as "supplied": .archon/.env + ~/.archon/.env
    // (read fresh, not from the process's full ambient environment — see
    // @archon/paths' getArchonEnvNames) plus config.yaml's env:.
    configuredEnvNames: new Set([
      ...archonPaths.getArchonEnvNames(cwd ?? process.cwd()),
      ...(options.envVarNames ?? []),
    ]),
    commandScan: {
      commandFolder: options.commandFolder,
      loadDefaultCommands: options.loadDefaultCommands,
    },
    allErrors: [],
  };
  // Map of filename -> workflow + source + parse warnings, for deduplication.
  // A later scope's `set()` replaces all three together, so a clean project file
  // can never inherit the bundled file's warnings (see ParsedWorkflowFile).
  const workflowsByFile: ScopeFiles = new Map();

  if (options.loadDefaults !== false) await loadBundledScope(context, workflowsByFile);
  await loadGlobalScope(context, workflowsByFile);
  // Skipped when cwd is null — surfaces bundled + home scopes only, which is the right answer
  // for callers without a project context (e.g. UI listing workflows before any codebase is registered).
  if (cwd === null) return finishDiscovery(context, workflowsByFile, 'no_project_context');
  await loadProjectScope(context, cwd, workflowsByFile);
  return finishDiscovery(context, workflowsByFile);
}

/**
 * Assemble the catalog: the legacy scopes, then installed entrypoints. A qualified
 * installed name wins over a legacy workflow declaring the same name, so no project or
 * global file can shadow an installed workflow.
 */
async function finishDiscovery(
  context: DiscoveryContext,
  workflowsByFile: ScopeFiles,
  scope?: string
): Promise<WorkflowLoadResult> {
  const { allErrors } = context;
  const verifiedFiles = context.capture?.verifiedFiles;
  const installed = await discoverInstalled(context);
  for (const [filename, { workflow, source }] of workflowsByFile) {
    if (installed.reservedNames.has(workflow.name.toLowerCase())) {
      allErrors.push({
        filename: workflow.name,
        error: `The ${source} workflow named '${workflow.name}' is not loaded: that name belongs to an installed plugin. Rename it.`,
        errorType: 'validation_error',
      });
      workflowsByFile.delete(filename);
    }
  }
  const legacy = await expandScope(context, workflowsByFile);
  allErrors.push(...legacy.errors);
  await assertCapturedFilesPresent(verifiedFiles);
  const workflows = [...legacy.workflows, ...installed.workflows];
  if (context.roots.kind === 'captured') {
    const failure = allErrors.find(
      error => error.errorType === 'read_error' && isSourceReadFailure(error.cause, verifiedFiles)
    );
    if (failure) {
      throw isSourceReadFailure(failure.cause)
        ? failure.cause
        : new WorkflowSourceUnavailableError(failure.filename, failure.cause);
    }
  }
  getLog().info(
    {
      count: workflows.length,
      errorCount: allErrors.length,
      ...(scope !== undefined ? { scope } : {}),
    },
    'workflows_discovery_completed'
  );
  return { workflows, support: installed.support, errors: allErrors };
}

/**
 * Discover workflows with config-aware default loading.
 *
 * Wraps discoverWorkflows with the standard pattern: loadConfig supplies
 * defaults.loadDefaultWorkflows and the command settings. A config that fails to
 * load rejects the discovery with that error, so listing surfaces report it
 * instead of listing with defaults.
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
    envVars?: Record<string, string>;
  }>,
  providers: ProviderRegistry,
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
  // A frozen capture already recorded config.yaml's env: names (see workflow-source/roots.ts'
  // workflowSourceConfigFrom); only the live branch below still needs to read them.
  let envVarNames: readonly string[] | undefined = sourceConfig?.env_var_names;
  if (cwd !== null && sourceConfig === undefined) {
    const cfg = await loadConfig(cwd);
    loadDefaults = cfg.defaults?.loadDefaultWorkflows ?? true;
    commandFolder = cfg.commands?.folder;
    loadDefaultCommands = cfg.defaults?.loadDefaultCommands;
    envVarNames = cfg.envVars && Object.keys(cfg.envVars);
  }
  return discoverWorkflows(cwd, {
    providers,
    loadDefaults,
    commandFolder,
    loadDefaultCommands,
    envVarNames,
    sourceRoots,
  });
}
