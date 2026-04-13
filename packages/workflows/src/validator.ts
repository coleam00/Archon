/**
 * Workflow and command validation — Level 3 (resource resolution).
 *
 * Levels 1-2 (syntax + structure) are handled by parseWorkflow() in loader.ts.
 * This module adds Level 3: checking that referenced resources actually exist
 * on disk (command files, MCP configs, skill directories).
 *
 * Lives in @archon/workflows (no @archon/core dependency) so both CLI and
 * REST API can use it.
 */

import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';
import { access, readFile } from 'fs/promises';
import {
  createLogger,
  getCommandFolderSearchPaths,
  getDefaultCommandsPath,
  findMarkdownFilesRecursive,
} from '@archon/paths';
import { execFileAsync } from '@archon/git';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { isValidCommandName } from './command-validation';
import { getProviderCapabilities, isRegisteredProvider } from '@archon/providers';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.validator');
  return cachedLog;
}
import { isScriptNode } from './schemas';
import type { WorkflowDefinition, DagNode } from './schemas';
import type { ScriptRuntime } from './script-discovery';
import { discoverScripts } from './script-discovery';
import { isInlineScript } from './executor-shared';

// =============================================================================
// Types
// =============================================================================

/** A single validation issue with actionable hint */
export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  field: string;
  message: string;
  hint?: string;
  suggestions?: string[];
}

/** Result of validating a single workflow (Level 3) */
export interface WorkflowValidationResult {
  workflowName: string;
  filename?: string;
  valid: boolean;
  issues: ValidationIssue[];
}

/** Create a WorkflowValidationResult with `valid` derived from issues */
export function makeWorkflowResult(
  workflowName: string,
  issues: ValidationIssue[],
  filename?: string
): WorkflowValidationResult {
  return {
    workflowName,
    ...(filename !== undefined && { filename }),
    valid: issues.every(i => i.level !== 'error'),
    issues,
  };
}

/** Result of validating a single command */
export interface CommandValidationResult {
  commandName: string;
  valid: boolean;
  issues: ValidationIssue[];
}

/** Config subset for validation (avoids WorkflowDeps dependency) */
export interface ValidationConfig {
  loadDefaultCommands?: boolean;
  commandFolder?: string;
}

// =============================================================================
// Levenshtein distance and fuzzy matching
// =============================================================================

/** Classic Levenshtein distance between two strings */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  return dp[m][n];
}

/** Find the closest matches from a list of candidates */
export function findSimilar(name: string, candidates: string[], maxDistance?: number): string[] {
  const threshold = maxDistance ?? Math.max(2, Math.floor(name.length * 0.3));
  const scored = candidates
    .map(c => ({ name: c, distance: levenshtein(name.toLowerCase(), c.toLowerCase()) }))
    .filter(s => s.distance <= threshold && s.distance > 0)
    .sort((a, b) => a.distance - b.distance);
  return scored.slice(0, 3).map(s => s.name);
}

// =============================================================================
// Command discovery
// =============================================================================

/** Check if a file exists */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all available command names from search paths and bundled defaults.
 * Returns deduplicated, sorted list of command names.
 */
export async function discoverAvailableCommands(
  cwd: string,
  config?: ValidationConfig
): Promise<string[]> {
  const names = new Set<string>();

  // Repo search paths (findMarkdownFilesRecursive returns [] for ENOENT)
  const searchPaths = getCommandFolderSearchPaths(config?.commandFolder);
  for (const folder of searchPaths) {
    const dirPath = join(cwd, folder);
    const files = await findMarkdownFilesRecursive(dirPath);
    for (const { commandName } of files) {
      names.add(commandName);
    }
  }

  // Bundled defaults
  const loadDefaults = config?.loadDefaultCommands !== false;
  if (loadDefaults) {
    if (isBinaryBuild()) {
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        names.add(name);
      }
    } else {
      const defaultsPath = getDefaultCommandsPath();
      const files = await findMarkdownFilesRecursive(defaultsPath);
      for (const { commandName } of files) {
        names.add(commandName);
      }
    }
  }

  return [...names].sort();
}

/**
 * Check if a command file can be resolved via the standard search paths.
 * Returns the resolved path if found, null otherwise.
 */
async function resolveCommand(
  commandName: string,
  cwd: string,
  config?: ValidationConfig
): Promise<string | null> {
  // Repo search paths
  const searchPaths = getCommandFolderSearchPaths(config?.commandFolder);
  for (const folder of searchPaths) {
    const filePath = join(cwd, folder, `${commandName}.md`);
    if (await fileExists(filePath)) {
      return filePath;
    }
  }

  // Bundled defaults
  const loadDefaults = config?.loadDefaultCommands !== false;
  if (loadDefaults) {
    if (isBinaryBuild()) {
      if (commandName in BUNDLED_COMMANDS) {
        return `[bundled:${commandName}]`;
      }
    } else {
      const defaultsPath = join(getDefaultCommandsPath(), `${commandName}.md`);
      if (await fileExists(defaultsPath)) {
        return defaultsPath;
      }
    }
  }

  return null;
}

// =============================================================================
// Runtime availability checking
// =============================================================================

/** Installation hints per runtime */
const RUNTIME_INSTALL_HINTS: Record<ScriptRuntime, string> = {
  bun: 'Install bun: https://bun.sh — or run: curl -fsSL https://bun.sh/install | bash',
  uv: 'Install uv: https://docs.astral.sh/uv/getting-started/installation/ — or run: curl -LsSf https://astral.sh/uv/install.sh | sh',
};

const runtimeCache = new Map<string, boolean>();

/** Clear the runtime availability cache (exposed for testing). */
export function clearRuntimeCache(): void {
  runtimeCache.clear();
}

/**
 * Check whether a runtime binary (bun or uv) is available on PATH.
 * Results are memoized per runtime name to avoid repeated subprocess spawns.
 */
export async function checkRuntimeAvailable(runtime: ScriptRuntime): Promise<boolean> {
  const cached = runtimeCache.get(runtime);
  if (cached !== undefined) return cached;
  try {
    await execFileAsync('which', [runtime]);
    runtimeCache.set(runtime, true);
    return true;
  } catch {
    runtimeCache.set(runtime, false);
    return false;
  }
}

// =============================================================================
// Workflow resource validation (Level 3)
// =============================================================================

/** Get the resolved provider for a node (node-level > workflow-level > config default).
 *  Returns undefined only when no provider is set at any level. */
function resolveProvider(
  node: DagNode,
  workflowProvider?: string,
  defaultProvider?: string
): string | undefined {
  if ('provider' in node && node.provider) return node.provider;
  return workflowProvider ?? defaultProvider;
}

/**
 * Validate a workflow's external resource references (Level 3).
 *
 * Checks that command files, MCP configs, and skill directories actually exist.
 * Call this AFTER parseWorkflow() has passed (Levels 1-2 are prerequisites).
 */
export async function validateWorkflowResources(
  workflow: WorkflowDefinition,
  cwd: string,
  config?: ValidationConfig,
  defaultProvider?: string
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const availableCommands = await discoverAvailableCommands(cwd, config);

  for (const node of workflow.nodes) {
    const provider = resolveProvider(node, workflow.provider, defaultProvider);

    // --- Command nodes: check file exists ---
    if ('command' in node && typeof node.command === 'string') {
      if (!isValidCommandName(node.command)) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          field: 'command',
          message: `Invalid command name '${node.command}' — must not contain '/', '\\', '..', or start with '.'`,
          hint: 'Use a simple name like "my-command" (without path separators or the .md extension)',
        });
        continue;
      }

      const resolved = await resolveCommand(node.command, cwd, config);
      if (!resolved) {
        const similar = findSimilar(node.command, availableCommands);
        const issue: ValidationIssue = {
          level: 'error',
          nodeId: node.id,
          field: 'command',
          message: `Command '${node.command}' not found`,
          hint: `Create .archon/commands/${node.command}.md or use an existing command name`,
        };
        if (similar.length > 0) {
          issue.hint = `Did you mean: ${similar.map(s => `'${s}'`).join(', ')}? Or create .archon/commands/${node.command}.md`;
          issue.suggestions = similar;
        }
        issues.push(issue);
      }
    }

    // --- MCP nodes: check config file exists and is valid JSON ---
    if ('mcp' in node && typeof node.mcp === 'string') {
      const mcpPath = isAbsolute(node.mcp) ? node.mcp : resolve(cwd, node.mcp);

      if (!(await fileExists(mcpPath))) {
        issues.push({
          level: 'error',
          nodeId: node.id,
          field: 'mcp',
          message: `MCP config file not found: '${node.mcp}'`,
          hint: `Create the file at ${mcpPath} with MCP server definitions (JSON format). Example:\n  {"server-name": {"command": "npx", "args": ["-y", "@package/name"], "env": {}}}`,
        });
      } else {
        // File exists — check it's valid JSON
        try {
          const content = await readFile(mcpPath, 'utf-8');
          const parsed = JSON.parse(content);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            issues.push({
              level: 'error',
              nodeId: node.id,
              field: 'mcp',
              message: `MCP config file '${node.mcp}' must be a JSON object (Record<string, ServerConfig>)`,
              hint: 'The file should contain a JSON object where each key is a server name',
            });
          }
        } catch (e) {
          const err = e as Error;
          issues.push({
            level: 'error',
            nodeId: node.id,
            field: 'mcp',
            message: `MCP config file '${node.mcp}' contains invalid JSON: ${err.message}`,
            hint: 'Fix the JSON syntax in the MCP config file',
          });
        }
      }

      // Warn if using MCP with a provider that doesn't support it
      if (provider && isRegisteredProvider(provider)) {
        const caps = getProviderCapabilities(provider);
        if (!caps.mcp) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            field: 'mcp',
            message: `MCP servers are not supported by provider '${provider}' — this will be ignored`,
            hint: 'Remove the mcp field or switch to a provider that supports MCP',
          });
        }
      }
    }

    // --- Skills nodes: check skill directories exist ---
    if ('skills' in node && Array.isArray(node.skills)) {
      for (const skillName of node.skills) {
        const projectSkillPath = join(cwd, '.claude', 'skills', skillName, 'SKILL.md');
        const userSkillPath = join(homedir(), '.claude', 'skills', skillName, 'SKILL.md');

        const projectExists = await fileExists(projectSkillPath);
        const userExists = await fileExists(userSkillPath);

        if (!projectExists && !userExists) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            field: 'skills',
            message: `Skill '${skillName}' not found in .claude/skills/ or ~/.claude/skills/`,
            hint: `Install with: npx skills add <repo> — or create manually at .claude/skills/${skillName}/SKILL.md`,
          });
        }
      }

      // Warn if using skills with a provider that doesn't support them
      if (provider && isRegisteredProvider(provider)) {
        const caps = getProviderCapabilities(provider);
        if (!caps.skills) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            field: 'skills',
            message: `Skills are not supported by provider '${provider}' — this will be ignored`,
            hint: 'Remove the skills field or switch to a provider that supports skills',
          });
        }
      }
    }

    // --- Capability-driven warnings for hooks and tool restrictions ---
    if (provider && isRegisteredProvider(provider)) {
      const caps = getProviderCapabilities(provider);

      if ('hooks' in node && node.hooks && !caps.hooks) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          field: 'hooks',
          message: `Hooks are not supported by provider '${provider}' — this will be ignored`,
          hint: 'Remove the hooks field or switch to a provider that supports hooks',
        });
      }

      if (!caps.toolRestrictions) {
        if (
          ('allowed_tools' in node && node.allowed_tools !== undefined) ||
          ('denied_tools' in node && node.denied_tools !== undefined)
        ) {
          issues.push({
            level: 'warning',
            nodeId: node.id,
            field: 'allowed_tools/denied_tools',
            message: `Tool restrictions are not supported by provider '${provider}' — this will be ignored`,
            hint: 'Remove tool restriction fields or switch to a provider that supports them',
          });
        }
      }
    }

    // --- Script nodes: check named script file exists + runtime available ---
    if (isScriptNode(node)) {
      const script = node.script;

      // Named script: validate file exists in .archon/scripts/
      if (!isInlineScript(script)) {
        const scriptsDir = resolve(cwd, '.archon', 'scripts');
        const extensions = node.runtime === 'uv' ? ['.py'] : ['.ts', '.js'];
        const existsResults = await Promise.all(
          extensions.map(ext => fileExists(join(scriptsDir, `${script}${ext}`)))
        );
        const scriptExists = existsResults.some(Boolean);

        if (!scriptExists) {
          issues.push({
            level: 'error',
            nodeId: node.id,
            field: 'script',
            message: `Named script '${script}' not found in .archon/scripts/`,
            hint: `Create .archon/scripts/${script}.${node.runtime === 'uv' ? 'py' : 'ts'} with your script code`,
          });
        }
      }

      // Runtime availability: warn if binary not on PATH
      const runtimeAvailable = await checkRuntimeAvailable(node.runtime);
      if (!runtimeAvailable) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          field: 'runtime',
          message: `Runtime '${node.runtime}' is not available on PATH`,
          hint: RUNTIME_INSTALL_HINTS[node.runtime],
        });
      }

      // Warn when deps is specified with bun (bun auto-installs, deps is a no-op)
      if (node.runtime === 'bun' && node.deps && node.deps.length > 0) {
        issues.push({
          level: 'warning',
          nodeId: node.id,
          field: 'deps',
          message: "'deps' is ignored for bun runtime (bun auto-installs packages at runtime)",
          hint: 'Remove deps or switch to runtime: uv if you need explicit dependency management',
        });
      }
    }
  }

  return issues;
}

// =============================================================================
// Command validation
// =============================================================================

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

// =============================================================================
// Script validation
// =============================================================================

/** Result of validating a single script */
export interface ScriptValidationResult {
  scriptName: string;
  valid: boolean;
  issues: ValidationIssue[];
}

/**
 * Discover all script names from .archon/scripts/ in the given cwd.
 * Returns a list of { name, path, runtime } entries.
 */
export async function discoverAvailableScripts(
  cwd: string
): Promise<{ name: string; path: string; runtime: ScriptRuntime }[]> {
  const scriptsDir = resolve(cwd, '.archon', 'scripts');
  try {
    const scripts = await discoverScripts(scriptsDir);
    return [...scripts.values()].map(s => ({ name: s.name, path: s.path, runtime: s.runtime }));
  } catch (error) {
    const err = error as Error;
    getLog().warn({ err, scriptsDir }, 'script_discovery_failed');
    return [];
  }
}

/**
 * Validate a single named script: file exists and runtime is available.
 */
export async function validateScript(
  scriptName: string,
  cwd: string
): Promise<ScriptValidationResult> {
  const issues: ValidationIssue[] = [];
  const scriptsDir = resolve(cwd, '.archon', 'scripts');

  // Find the script file (any supported extension)
  const allExtensions = ['.ts', '.js', '.py'];
  let foundPath: string | null = null;
  let detectedRuntime: ScriptRuntime | null = null;

  for (const ext of allExtensions) {
    const candidate = join(scriptsDir, `${scriptName}${ext}`);
    if (await fileExists(candidate)) {
      foundPath = candidate;
      detectedRuntime = ext === '.py' ? 'uv' : 'bun';
      break;
    }
  }

  if (!foundPath || !detectedRuntime) {
    issues.push({
      level: 'error',
      field: 'file',
      message: `Script '${scriptName}' not found in .archon/scripts/`,
      hint: `Create .archon/scripts/${scriptName}.ts (bun) or .archon/scripts/${scriptName}.py (uv)`,
    });
    return { scriptName, valid: false, issues };
  }

  // Check runtime availability
  const runtimeAvailable = await checkRuntimeAvailable(detectedRuntime);
  if (!runtimeAvailable) {
    issues.push({
      level: 'warning',
      field: 'runtime',
      message: `Runtime '${detectedRuntime}' is not available on PATH`,
      hint: RUNTIME_INSTALL_HINTS[detectedRuntime],
    });
  }

  return {
    scriptName,
    valid: issues.filter(i => i.level === 'error').length === 0,
    issues,
  };
}
