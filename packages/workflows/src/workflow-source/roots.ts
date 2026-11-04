import { join } from 'path';
import * as archonPaths from '@archon/paths';
import type { WorkflowSourceConfig } from '../schemas/workflow-run';
import type { WorkflowConfig } from '../deps';

export const PROJECT_SCOPE_DIR = 'project';
export const GLOBAL_SCOPE_DIR = 'global';
export const BUNDLED_SCOPE_DIR = 'bundled';
export const INSTALLED_SCOPE_DIR = 'installed';

/**
 * The roots every source lookup resolves under.
 *
 * Naming the three scopes explicitly is what lets one set of resolvers serve both a live
 * checkout and a run's frozen capture: the live form derives them from `ARCHON_HOME` and
 * a project root, the captured form from a capture directory, and nothing downstream has
 * to know which it was handed.
 */
interface WorkflowSourceRootPaths {
  /** Project root (the directory containing `.archon/`), or null with no project context. */
  readonly project: string | null;
  readonly globalWorkflows: string;
  readonly globalCommands: string;
  readonly globalScripts: string;
  /** Directory holding the bundled packs. */
  readonly bundledWorkflows: string;
  /** Where installed workflow packs are read from. */
  readonly installed: InstalledPacksRoot;
}

/**
 * Installed packs come either from the live receipts under `ARCHON_HOME/plugins`, or
 * from a capture's `installed/` directory (one directory per pack, named by its
 * {@link InstalledPack.key}). A `workflow:` child reads live project source with its
 * parent's captured packs, so this is chosen apart from the rest of the roots.
 */
export type InstalledPacksRoot =
  | { readonly kind: 'receipts'; readonly pluginsDir: string }
  | { readonly kind: 'captured'; readonly captureRoot: string };

/** Out-of-band identity that every late read from a captured source must recheck. */
export interface WorkflowSourceAnchor {
  readonly root: string;
  readonly digest: string;
  readonly config: WorkflowSourceConfig;
}

export interface LiveWorkflowSourceRoots extends WorkflowSourceRootPaths {
  readonly kind: 'live';
  readonly config: WorkflowSourceConfig;
}

export interface CapturedWorkflowSourceRoots extends WorkflowSourceRootPaths {
  readonly kind: 'captured';
  readonly anchor: WorkflowSourceAnchor;
  /** Flat bundled commands an older build froze. Current builds bundle only packaged
   * commands, so only a capture can hold these. */
  readonly bundledCommands: string;
}

export type WorkflowSourceRoots = LiveWorkflowSourceRoots | CapturedWorkflowSourceRoots;

export function workflowSourceConfigForRoots(roots: WorkflowSourceRoots): WorkflowSourceConfig {
  return roots.kind === 'captured' ? roots.anchor.config : roots.config;
}

export const DEFAULT_WORKFLOW_SOURCE_CONFIG: WorkflowSourceConfig = {
  load_default_workflows: true,
  load_default_commands: true,
};

/**
 * Narrow an install's config down to the settings a capture must freeze.
 *
 * Every caller that captures needs exactly this projection, and a second copy of it is
 * how one entry point ends up freezing a different set of directories than another:
 * a repo pointing `commands.folder` outside `.archon/commands` would have its commands
 * captured by `workflow run` and missed by `workflow test`.
 */
export function workflowSourceConfigFrom(config: WorkflowConfig): WorkflowSourceConfig {
  return {
    load_default_workflows: config.defaults?.loadDefaultWorkflows ?? true,
    load_default_commands: config.defaults?.loadDefaultCommands ?? true,
    ...(config.commands?.folder !== undefined ? { command_folder: config.commands.folder } : {}),
    ...(config.envVars !== undefined ? { env_var_names: Object.keys(config.envVars) } : {}),
  };
}

/** Roots for reading source live off disk, exactly as Archon always has. */
export function liveSourceRoots(
  project: string | null,
  config: WorkflowSourceConfig = DEFAULT_WORKFLOW_SOURCE_CONFIG,
  installed: InstalledPacksRoot = {
    kind: 'receipts',
    pluginsDir: archonPaths.getPluginsPath(),
  }
): LiveWorkflowSourceRoots {
  return {
    project,
    globalWorkflows: archonPaths.getHomeWorkflowsPath(),
    globalCommands: archonPaths.getHomeCommandsPath(),
    globalScripts: archonPaths.getHomeScriptsPath(),
    bundledWorkflows: archonPaths.getBundledWorkflowsPath(),
    installed,
    kind: 'live',
    config,
  };
}

/**
 * Roots for reading a run's frozen capture.
 *
 * Bundled defaults use the same captured paths in every build. A compiled binary
 * materializes its embedded constants into this tree when the capture is created.
 */
export function capturedSourceRoots(anchor: WorkflowSourceAnchor): CapturedWorkflowSourceRoots {
  const captureRoot = anchor.root;
  return {
    project: join(captureRoot, PROJECT_SCOPE_DIR),
    globalWorkflows: join(captureRoot, GLOBAL_SCOPE_DIR, 'workflows'),
    globalCommands: join(captureRoot, GLOBAL_SCOPE_DIR, 'commands'),
    globalScripts: join(captureRoot, GLOBAL_SCOPE_DIR, 'scripts'),
    // Always the capture, binary or not. A binary's bundled set is materialized into it
    // at capture time, which is what lets a paused run resume across an Archon upgrade
    // instead of failing because its bundled bytes could not be verified.
    bundledWorkflows: join(captureRoot, BUNDLED_SCOPE_DIR, 'workflows'),
    bundledCommands: join(captureRoot, BUNDLED_SCOPE_DIR, 'commands', 'defaults'),
    installed: { kind: 'captured', captureRoot },
    kind: 'captured',
    anchor,
  };
}
