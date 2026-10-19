import { readFile } from 'fs/promises';
import { join } from 'path';
import * as archonPaths from '@archon/paths';
import { createLogger } from '@archon/paths';
import type { WorkflowDeps } from './deps';
import {
  liveSourceRoots,
  capturedSourceReadGuard,
  assertCapturedFilesPresent,
  packagedWorkflowDirectory,
  workflowSourceConfigForRoots,
  type WorkflowSourceRoots,
} from './workflow-source';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { bundlesPackagedResources } from './defaults/bundle-inventory';
import { isValidCommandName } from './command-validation';
import type { LoadCommandResult } from './schemas';
import {
  parsePackagedResourceReference,
  type PackagedResourceReference,
} from './packaged-workflow';

/** Lazy-initialized logger, under the executor-shared name these events have always carried. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor-shared');
  return cachedLog;
}

/**
 * Load command prompt from file.
 *
 * Two directories are in play and they are not interchangeable. `cwd` is the workspace
 * the run acts on: it owns config, and it is where a `commands.folder` setting is read
 * from. `sourceRoots` is where the command TEXT lives — the authoring checkout, or a
 * run's frozen capture of it. They describe the same place for an ordinary in-place run
 * and differ whenever a workflow authored in one checkout executes against another.
 * Passing `cwd` for both is what made a workflow's own commands invisible inside its
 * isolated worktree.
 *
 * @param deps - Workflow dependencies (for config loading)
 * @param cwd - Target workspace; owns config only
 * @param commandName - Name of the command (without .md extension)
 * @param configuredFolder - Optional additional folder from config to search
 * @param sourceRoots - Roots to resolve command files under; defaults to reading `cwd` live
 * @returns On success: `{ success: true, content }`. On failure: `{ success: false, reason, message }`.
 */
export async function loadCommandPrompt(
  deps: Pick<WorkflowDeps, 'loadConfig'>,
  cwd: string,
  commandName: string,
  configuredFolder?: string,
  sourceRoots?: WorkflowSourceRoots,
  verifiedFiles?: ReadonlySet<string>
): Promise<LoadCommandResult> {
  const roots = sourceRoots ?? liveSourceRoots(cwd);
  const sourceConfig = sourceRoots && workflowSourceConfigForRoots(sourceRoots);
  // Validate command name first
  if (!isValidCommandName(commandName)) {
    getLog().error({ commandName }, 'invalid_command_name');
    return {
      success: false,
      reason: 'invalid_name',
      message: `Invalid command name (potential path traversal): ${commandName}`,
    };
  }

  // Opt-out comes from the SOURCE when there is one — a capture carries the settings that
  // were in force when it was taken, so a resume cannot let the target's `defaults:`
  // decide whether the bundled scope counts. Falls back to reading `cwd` live.
  const loadDefaultCommands =
    sourceConfig?.load_default_commands ?? (await configuredLoadDefaultCommands(deps, cwd));

  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) {
    return loadPackagedCommand(commandName, packaged, roots, loadDefaultCommands, verifiedFiles);
  }

  // Use command folder paths with optional configured folder.
  // Each scope is walked 1 subfolder deep so `triage/review.md` resolves as
  // `review` — matching the workflows/scripts convention. Resolution
  // precedence: repo > home (~/.archon/commands/) > a capture's frozen flat defaults.
  // The SOURCE's command folder, when a capture supplied one. `configuredFolder` is the
  // target's, which is the right answer only for an in-place run — for a captured run it
  // would search folders the frozen source never used.
  const searchPaths = archonPaths.getCommandFolderSearchPaths(
    sourceConfig?.command_folder ?? configuredFolder
  );
  const projectRoot = roots.project;
  const resolvedSearchPaths: string[] = [
    ...(projectRoot !== null ? searchPaths.map(folder => join(projectRoot, folder)) : []),
    roots.globalCommands,
  ];
  const searched = await loadSearchedCommand(commandName, resolvedSearchPaths, verifiedFiles);
  if (searched !== undefined) return searched;

  // Every bundled command a build ships now is packaged and resolved above. A run captured
  // by an older build may have frozen flat bundled commands; it keeps reading those bytes,
  // with the basename walk, so it can resume across the upgrade.
  if (loadDefaultCommands && roots.kind === 'captured') {
    const frozen = await loadFrozenDefaultCommand(
      commandName,
      roots.bundledCommands,
      verifiedFiles
    );
    if (frozen !== undefined) return frozen;
  }

  // Not found anywhere
  const allSearchPaths =
    loadDefaultCommands && roots.kind === 'captured'
      ? [...searchPaths, 'app defaults']
      : searchPaths;
  getLog().error({ commandName, searchPaths: allSearchPaths }, 'command_not_found');
  return {
    success: false,
    reason: 'not_found',
    message: `Command prompt not found: ${commandName}.md (searched: ${allSearchPaths.join(', ')})`,
  };
}

async function configuredLoadDefaultCommands(
  deps: Pick<WorkflowDeps, 'loadConfig'>,
  cwd: string
): Promise<boolean> {
  try {
    return (await deps.loadConfig(cwd)).defaults?.loadDefaultCommands ?? true;
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      {
        err,
        cwd,
        note: 'Default commands will be loaded. Check your .archon/config.yaml if this is unexpected.',
      },
      'config_load_failed_using_defaults'
    );
    return true;
  }
}

async function loadPackagedCommand(
  commandName: string,
  packaged: PackagedResourceReference,
  roots: WorkflowSourceRoots,
  loadDefaultCommands: boolean,
  verifiedFiles: ReadonlySet<string> | undefined
): Promise<LoadCommandResult> {
  if (packaged.owner.source === 'bundled') {
    if (
      !loadDefaultCommands ||
      (roots.kind === 'live' &&
        !isBinaryBuild() &&
        !(await bundlesPackagedResources(packaged.owner.pack)))
    ) {
      return {
        success: false,
        reason: 'not_found',
        message: `Packaged command not found: ${packaged.name}.md`,
      };
    }
    // A captured run reads the bundled bytes IT froze, even in a binary: the capture
    // materialized the constants to files, and those are what its digest covers.
    if (isBinaryBuild() && roots.kind === 'live') {
      return embeddedBundledCommand(commandName, packaged.name);
    }
  }

  const workflowDir = await packagedWorkflowDirectory(roots, packaged.owner);
  await assertCapturedFilesPresent(verifiedFiles);
  if (workflowDir === null) {
    return {
      success: false,
      reason: 'not_found',
      message: `Packaged command not found (no ${packaged.owner.source} source): ${packaged.name}.md`,
    };
  }
  return readPackagedCommandFile(commandName, join(workflowDir, 'commands', `${packaged.name}.md`));
}

function embeddedBundledCommand(commandName: string, name: string): LoadCommandResult {
  const content = BUNDLED_COMMANDS[commandName];
  if (content === undefined) {
    return {
      success: false,
      reason: 'not_found',
      message: `Packaged command not found: ${name}.md`,
    };
  }
  if (!content.trim()) {
    return {
      success: false,
      reason: 'empty_file',
      message: `Command file is empty: ${name}.md`,
    };
  }
  return { success: true, content };
}

async function readPackagedCommandFile(
  commandName: string,
  filePath: string
): Promise<LoadCommandResult> {
  try {
    const content = await readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return {
        success: false,
        reason: 'empty_file',
        message: `Command file is empty: ${filePath}`,
      };
    }
    return { success: true, content };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    let reason: 'permission_denied' | 'not_found' | 'read_error';
    if (err.code === 'EACCES') {
      reason = 'permission_denied';
    } else if (err.code === 'ENOENT') {
      reason = 'not_found';
    } else {
      reason = 'read_error';
    }
    if (err.code !== 'ENOENT') {
      getLog().error({ err, commandName, filePath }, 'packaged_command_file_read_error');
    }
    return {
      success: false,
      reason,
      cause: error,
      message:
        err.code === 'ENOENT'
          ? `Packaged command not found: ${filePath}`
          : `Error reading packaged command ${filePath}: ${err.message}`,
    };
  }
}

/** The first search directory holding the command decides; undefined when none holds it. */
async function loadSearchedCommand(
  commandName: string,
  searchDirs: readonly string[],
  verifiedFiles: ReadonlySet<string> | undefined
): Promise<LoadCommandResult | undefined> {
  for (const dir of searchDirs) {
    const entries = await archonPaths.findCommandFiles(dir, capturedSourceReadGuard(verifiedFiles));
    await assertCapturedFilesPresent(verifiedFiles);
    const match = entries.find(e => e.commandName === commandName);
    if (!match) continue;

    const filePath = join(dir, match.relativePath);
    try {
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        getLog().error({ commandName }, 'command_file_empty');
        return {
          success: false,
          reason: 'empty_file',
          message: `Command file is empty: ${commandName}.md`,
        };
      }
      getLog().debug({ commandName, filePath }, 'command_loaded');
      return { success: true, content };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EACCES') {
        getLog().error({ commandName, filePath }, 'command_file_permission_denied');
        return {
          success: false,
          reason: 'permission_denied',
          cause: error,
          message: `Permission denied reading command: ${commandName}.md`,
        };
      }
      // Other unexpected errors (ENOENT shouldn't happen since the walk just found it,
      // but if the file was deleted between walk and read we fall through to 'not found'
      // with a log.)
      getLog().error({ err, commandName, filePath }, 'command_file_read_error');
      return {
        success: false,
        reason: 'read_error',
        cause: error,
        message: `Error reading command ${commandName}.md: ${err.message}`,
      };
    }
  }
  return undefined;
}

/** A capture's frozen flat default command; undefined when the capture holds none by that name. */
async function loadFrozenDefaultCommand(
  commandName: string,
  appDefaultsPath: string,
  verifiedFiles: ReadonlySet<string> | undefined
): Promise<LoadCommandResult | undefined> {
  const entries = await archonPaths.findCommandFiles(
    appDefaultsPath,
    capturedSourceReadGuard(verifiedFiles)
  );
  await assertCapturedFilesPresent(verifiedFiles);
  const match = entries.find(e => e.commandName === commandName);
  if (!match) {
    getLog().debug({ commandName }, 'command_app_default_not_found');
    return undefined;
  }
  try {
    const content = await readFile(join(appDefaultsPath, match.relativePath), 'utf-8');
    if (!content.trim()) {
      getLog().error({ commandName }, 'command_app_default_empty');
      return {
        success: false,
        reason: 'empty_file',
        message: `App default command file is empty: ${commandName}.md`,
      };
    }
    getLog().debug({ commandName }, 'command_loaded_app_defaults');
    return { success: true, content };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      getLog().warn({ err, commandName }, 'command_app_default_read_error');
    } else {
      getLog().debug({ commandName }, 'command_app_default_not_found');
    }
    return {
      success: false,
      reason: 'read_error',
      cause: error,
      message: `Error reading app default command ${commandName}.md: ${err.message}`,
    };
  }
}
