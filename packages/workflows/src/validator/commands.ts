import { join } from 'path';
import { readFile, stat } from 'fs/promises';
import { getCommandFolderSearchPaths, getHomeCommandsPath, findCommandFiles } from '@archon/paths';
import type { DagNode } from '../schemas';
import { isAgentNode, isLoopNode } from '../schemas';
import { BUNDLED_COMMANDS, isBinaryBuild } from '../defaults/bundled-defaults';
import { bundlesPackagedResources } from '../defaults/bundle-inventory';
import { isValidCommandName } from '../command-validation';
import { findSimilar } from '../utils/fuzzy-match';
import { parsePackagedResourceReference } from '../packaged-workflow';
import { liveSourceRoots, packagedWorkflowDirectory } from '../workflow-source';
import type { ResourceValidation } from './context';
import type { CommandValidationResult, ValidationConfig, ValidationIssue } from './types';
import { getLog } from './log';

/**
 * Discover all available flat command names from the project and home search paths.
 * Returns deduplicated, sorted list of command names.
 */
export async function discoverAvailableCommands(
  cwd: string,
  config?: ValidationConfig
): Promise<string[]> {
  const names = new Set<string>();

  // Each scope is walked 1 subfolder deep (matches the workflows/scripts
  // discovery convention — supports `defaults/` grouping, rejects deeper nesting).

  // 1. Repo search paths
  const searchPaths = getCommandFolderSearchPaths(config?.commandFolder);
  for (const folder of searchPaths) {
    const dirPath = join(cwd, folder);
    const files = await findCommandFiles(dirPath);
    for (const { commandName } of files) {
      names.add(commandName);
    }
  }

  // 2. Home-scoped commands (~/.archon/commands/) — personal helpers reusable across repos.
  // ENOENT already returns []; we only catch other errors (EACCES/EPERM/EIO) so a broken
  // home-scope doesn't take down repo discovery.
  const homePath = getHomeCommandsPath();
  try {
    const homeCommands = await findCommandFiles(homePath);
    for (const { commandName } of homeCommands) {
      names.add(commandName);
    }
  } catch (err) {
    getLog().warn({ err, path: homePath }, 'commands.home_discovery_failed');
  }

  return [...names].sort();
}

/**
 * Resolve a command name to a file path within a single directory, walking at
 * most 1 subfolder deep. Returns the first `.md` file whose basename matches
 * `commandName`, or `null` if nothing matches.
 *
 * Within a single scope, if two files in different subfolders share a basename
 * (e.g. `triage/review.md` and `team/review.md`), the earlier match by the
 * deterministic walk order wins — duplicates within a scope are a user error.
 */
async function resolveCommandInDir(rootDir: string, commandName: string): Promise<string | null> {
  const entries = await findCommandFiles(rootDir);
  const match = entries.find(e => e.commandName === commandName);
  return match ? join(rootDir, match.relativePath) : null;
}

/**
 * Check if a command file can be resolved via the standard search paths.
 * Returns the resolved path if found, null otherwise.
 *
 * Resolution precedence (first hit wins):
 *   1. Repo-local — `<cwd>/.archon/commands/` and configured folders
 *   2. Home-scoped — `~/.archon/commands/` (personal helpers, reusable across repos)
 *
 * Bundled commands are always packaged (`pack/workflow/name`) and resolve above.
 */
async function resolveCommand(
  commandName: string,
  cwd: string,
  config?: ValidationConfig
): Promise<string | null> {
  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) return resolvePackagedCommand(commandName, packaged, cwd, config);

  // Each scope is walked 1 subfolder deep by basename — so `triage/review.md`
  // is resolvable as `review`. This matches the workflows/scripts discovery
  // convention and makes the listed commands in `discoverAvailableCommands`
  // actually resolvable.

  // 1. Repo search paths
  const searchPaths = getCommandFolderSearchPaths(config?.commandFolder);
  for (const folder of searchPaths) {
    const resolved = await resolveCommandInDir(join(cwd, folder), commandName);
    if (resolved) return resolved;
  }

  // 2. Home-scoped commands (~/.archon/commands/).
  // ENOENT on the home dir already returns null; only wrap for other errors so a
  // broken home-scope reads as unresolved rather than failing validation.
  try {
    const homeResolved = await resolveCommandInDir(getHomeCommandsPath(), commandName);
    if (homeResolved) return homeResolved;
  } catch (err) {
    getLog().warn({ err, commandName }, 'commands.home_resolve_failed');
  }

  return null;
}

async function resolvePackagedCommand(
  commandName: string,
  packaged: NonNullable<ReturnType<typeof parsePackagedResourceReference>>,
  cwd: string,
  config: ValidationConfig | undefined
): Promise<string | null> {
  if (packaged.owner.source === 'bundled') {
    if (config?.loadDefaultCommands === false) return null;
    if (isBinaryBuild()) {
      return commandName in BUNDLED_COMMANDS ? `[bundled:${commandName}]` : null;
    }
    if (!(await bundlesPackagedResources(packaged.owner.pack))) return null;
  }
  const workflowDir = await packagedWorkflowDirectory(liveSourceRoots(cwd), packaged.owner);
  if (workflowDir === null) return null;
  const path = join(workflowDir, 'commands', `${packaged.name}.md`);
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    getLog().error({ err, path, commandName }, 'packaged_command_inspection_failed');
    throw new Error(`Cannot inspect packaged command '${commandName}': ${err.message}`, {
      cause: err,
    });
  }
}

/**
 * Command nodes and `loop.command` resolve to a command file. Returns false when the
 * node's command name is invalid; the node's remaining checks are then skipped.
 */
export async function validateCommandReferences(
  validation: ResourceValidation,
  node: DagNode
): Promise<boolean> {
  if (isAgentNode(node) && node.source.kind === 'command') {
    return validateCommandReference(validation, node.id, 'command', node.source.name);
  }
  if (isLoopNode(node) && node.loop.command !== undefined) {
    await validateCommandReference(validation, node.id, 'loop.command', node.loop.command);
  }
  return true;
}

/** Report an invalid or unresolvable command name; returns whether the name is valid. */
async function validateCommandReference(
  validation: ResourceValidation,
  nodeId: string,
  field: 'command' | 'loop.command',
  commandName: string
): Promise<boolean> {
  if (!isValidCommandName(commandName)) {
    validation.issues.push({
      level: 'error',
      nodeId,
      field,
      message: `Invalid command name '${commandName}' — must not contain '/', '\\', '..', or start with '.'`,
      hint: 'Use a simple name like "my-command" (without path separators or the .md extension)',
    });
    return false;
  }

  const resolved = await resolveCommand(commandName, validation.cwd, validation.config);
  if (!resolved) {
    const similar = findSimilar(commandName, [...validation.availableCommands]);
    const issue: ValidationIssue = {
      level: 'error',
      nodeId,
      field,
      message: `Command '${commandName}' not found`,
      hint: `Create .archon/commands/${commandName}.md or use an existing command name`,
    };
    if (similar.length > 0) {
      issue.hint = `Did you mean: ${similar.map(s => `'${s}'`).join(', ')}? Or create .archon/commands/${commandName}.md`;
      issue.suggestions = similar;
    }
    validation.issues.push(issue);
  }
  return true;
}

/**
 * Validate a single command file: exists, non-empty, valid name.
 */
export async function validateCommand(
  commandName: string,
  cwd: string,
  config?: ValidationConfig
): Promise<CommandValidationResult> {
  const issues: ValidationIssue[] = [];

  if (!isValidCommandName(commandName)) {
    issues.push({
      level: 'error',
      field: 'name',
      message: `Invalid command name '${commandName}' — must not contain '/', '\\', '..', or start with '.'`,
      hint: 'Use a simple name like "my-command" (without path separators)',
    });
    return { commandName, valid: false, issues };
  }

  const resolved = await resolveCommand(commandName, cwd, config);
  if (!resolved) {
    const availableCommands = await discoverAvailableCommands(cwd, config);
    const similar = findSimilar(commandName, availableCommands);
    const issue: ValidationIssue = {
      level: 'error',
      field: 'file',
      message: `Command '${commandName}' not found`,
      hint: `Create .archon/commands/${commandName}.md`,
    };
    if (similar.length > 0) {
      issue.hint = `Did you mean: ${similar.map(s => `'${s}'`).join(', ')}?`;
      issue.suggestions = similar;
    }
    issues.push(issue);
    return { commandName, valid: false, issues };
  }

  // For non-bundled commands, check file is non-empty
  if (!resolved.startsWith('[bundled:')) {
    try {
      const content = await readFile(resolved, 'utf-8');
      if (content.trim().length === 0) {
        issues.push({
          level: 'error',
          field: 'content',
          message: `Command file '${commandName}' is empty`,
          hint: `Add prompt content to ${resolved}`,
        });
      }
    } catch (e) {
      const err = e as Error;
      issues.push({
        level: 'error',
        field: 'file',
        message: `Cannot read command file '${commandName}': ${err.message}`,
        hint: 'Check file permissions',
      });
    }
  }

  return {
    commandName,
    valid: issues.filter(i => i.level === 'error').length === 0,
    issues,
  };
}
