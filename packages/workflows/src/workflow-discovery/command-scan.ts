import { readFile } from 'fs/promises';
import { join } from 'path';
import * as archonPaths from '@archon/paths';
import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import { isComposeFanOutNode, isIncludeDirective, isLoopGroupNode } from '../schemas';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { bundlesPackagedResources } from '../defaults/bundle-inventory';
import { isValidCommandName } from '../command-validation';
import { collectFileBackedCommandNames } from '../command-file';
import { parsePackagedResourceReference } from '../packaged-workflow';
import type { IncludeCommandContent } from '../compiled-command';
import {
  assertCapturedFilesPresent,
  packagedWorkflowDirectory,
  workflowSourceConfigForRoots,
  type WorkflowSourceRoots,
} from '../workflow-source';

/**
 * Command-resolution config that keeps the include safety scan at parity with the
 * runtime/validator command lookup: the configured extra `commandFolder` and the
 * `loadDefaultCommands` opt-out. Threaded from `discoverWorkflowsWithConfig` (which loads
 * `.archon/config.yaml`); direct `discoverWorkflows` callers get the defaults.
 */
export interface CommandScanConfig {
  commandFolder?: string;
  loadDefaultCommands?: boolean;
}

type PackagedCommandReference = NonNullable<ReturnType<typeof parsePackagedResourceReference>>;

/**
 * Resolve a command name to its file CONTENT, mirroring the runtime/validator search
 * order (repo `.archon/commands/` + configured `commandFolder` → `~/.archon/commands/` →
 * a capture's frozen flat defaults, unless `loadDefaultCommands` is false). Returns `null` when no candidate
 * resolves, and a path-bearing error when a higher-precedence scope cannot be inspected or a
 * matched candidate cannot be read. Read-only; used so the include expander can compile a
 * block's command body while proving its lexical reference boundary.
 */
export async function resolveCommandContentForScan(
  roots: WorkflowSourceRoots,
  commandName: string,
  config: CommandScanConfig
): Promise<IncludeCommandContent> {
  if (!isValidCommandName(commandName)) return null;

  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) return resolvePackagedCommand(roots, commandName, packaged, config);

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
    const content = await readCommandFromDir(dir, commandName);
    if (content !== undefined) return content;
  }

  // Every bundled command a build ships now is packaged and resolved above. A run captured
  // by an older build may have frozen flat bundled commands and keeps the basename walk
  // over them — unless the repo opted out (loadDefaultCommands: false), matching discovery.
  if (config.loadDefaultCommands === false || roots.kind !== 'captured') return null;
  return (await readCommandFromDir(roots.bundledCommands, commandName)) ?? null;
}

async function resolvePackagedCommand(
  roots: WorkflowSourceRoots,
  commandName: string,
  packaged: PackagedCommandReference,
  config: CommandScanConfig
): Promise<IncludeCommandContent> {
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
    return { path: commandPath, message: err.message, operation: 'read', cause: error };
  }
}

/** A command's content from one search directory; `undefined` when the directory lacks it. */
async function readCommandFromDir(
  dir: string,
  commandName: string
): Promise<IncludeCommandContent | undefined> {
  let entries: Awaited<ReturnType<typeof archonPaths.findCommandFiles>>;
  try {
    entries = await archonPaths.findCommandFiles(dir);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return undefined;
    return { path: dir, message: err.message, operation: 'inspect', cause: error };
  }
  const match = entries.find(e => e.commandName === commandName);
  if (!match) return undefined;
  const commandPath = join(dir, match.relativePath);
  try {
    return await readFile(commandPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { path: commandPath, message: err.message, operation: 'read', cause: error };
  }
}

/**
 * Pre-resolve command-file contents for every file-backed command node (including
 * `loop.command`) that lives in a workflow reachable as an `include:` target
 * (transitively). The include expander uses these to validate deferred prompt bodies.
 * Touches disk only when includes exist; returns an empty map otherwise.
 */
export async function resolveIncludeBlockCommandContents(
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
  }[],
  verifiedFiles: ReadonlySet<string> | undefined
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
  await assertCapturedFilesPresent(verifiedFiles);
  return contents;
}
