import { execFileAsync } from '@archon/git';
import type { DagNode } from '../schemas';
import { isExecNode } from '../schemas';
import type { ScriptRuntime } from '../script-discovery';
import { discoverScriptsForCwd } from '../script-discovery';
import { isInlineScript } from '../executor-shared';
import type { ResourceValidation } from './context';
import type { ScriptValidationResult, ValidationIssue } from './types';

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

/** A script node's named script exists and its runtime is on PATH. */
export async function validateScriptNode(
  validation: ResourceValidation,
  node: DagNode
): Promise<void> {
  if (!isExecNode(node) || node.runtime === 'sh') return;
  const { issues } = validation;
  const script = node.script;

  // Named script: validate file exists in repo or home scope.
  // Precedence mirrors dag-executor: repo > home. Subfolders up to 1 level deep
  // are searched by discoverScriptsForCwd, matching the workflows/commands convention.
  if (!isInlineScript(script)) {
    const scripts = await discoverScriptsForCwd(validation.cwd);
    const entry = scripts.get(script);
    const scriptExists =
      entry !== undefined &&
      (node.runtime === 'uv' ? entry.runtime === 'uv' : entry.runtime === 'bun');

    if (!scriptExists) {
      issues.push({
        level: 'error',
        nodeId: node.id,
        field: 'script',
        message: `Named script '${script}' not found in .archon/scripts/ or ~/.archon/scripts/`,
        hint: `Create .archon/scripts/${script}.${node.runtime === 'uv' ? 'py' : 'ts'} with your script code (or place at ~/.archon/scripts/ to share across repos)`,
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

/**
 * Discover all shared and packaged script names.
 * Returns a list of { name, path, runtime } entries. Repo-scoped shared
 * scripts override same-named home entries; packaged names retain ownership.
 * Filesystem failures propagate so validation cannot report a false success.
 */
export async function discoverAvailableScripts(
  cwd: string
): Promise<{ name: string; path: string; runtime: ScriptRuntime }[]> {
  const scripts = await discoverScriptsForCwd(cwd);
  return [...scripts.values()].map(s => ({ name: s.name, path: s.path, runtime: s.runtime }));
}

/**
 * Validate a single named script: file exists and runtime is available.
 */
export async function validateScript(
  scriptName: string,
  cwd: string
): Promise<ScriptValidationResult> {
  const issues: ValidationIssue[] = [];

  // Look up across repo + home scopes (repo wins). discoverScriptsForCwd handles
  // both 1-depth subfolders and the repo/home precedence.
  const scripts = await discoverScriptsForCwd(cwd);
  const entry = scripts.get(scriptName);

  const foundPath = entry?.path ?? null;
  const detectedRuntime = entry?.runtime ?? null;

  if (!foundPath || !detectedRuntime) {
    issues.push({
      level: 'error',
      field: 'file',
      message: `Script '${scriptName}' not found in .archon/scripts/ or ~/.archon/scripts/`,
      hint: `Create .archon/scripts/${scriptName}.ts (bun) or .archon/scripts/${scriptName}.py (uv). Place at ~/.archon/scripts/ to share across repos.`,
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
