/**
 * Script discovery - finds and loads script files from .archon/scripts/.
 *
 * Scripts are keyed by filename without extension. Runtime is auto-detected
 * from the file extension: .ts/.js -> bun, .py -> uv.
 */
import { readdir, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import { createLogger, getHomeScriptsPath } from '@archon/paths';

/** Normalize path separators to forward slashes for cross-platform consistency */
function normalizeSep(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.script-discovery');
  return cachedLog;
}

/** Supported script runtime */
export type ScriptRuntime = 'bun' | 'uv';

/** A discovered script with its metadata */
export interface ScriptDefinition {
  name: string;
  path: string;
  runtime: ScriptRuntime;
}

/** Supported file extensions and their runtimes */
const EXTENSION_RUNTIME_MAP: Record<string, ScriptRuntime> = {
  '.ts': 'bun',
  '.js': 'bun',
  '.py': 'uv',
};

/**
 * Derive the runtime from a file extension.
 * Returns undefined for unknown extensions.
 */
function getRuntimeForExtension(ext: string): ScriptRuntime | undefined {
  return EXTENSION_RUNTIME_MAP[ext];
}

/**
 * Maximum subfolder depth we descend into when scanning scripts.
 *
 * `1` matches the workflows/commands convention: allow one level of
 * grouping (e.g. `.archon/scripts/triage/foo.ts`) but no nested folders.
 */
const MAX_SCRIPT_DISCOVERY_DEPTH = 1;

/**
 * Scan a directory for script files, descending at most `MAX_SCRIPT_DISCOVERY_DEPTH`
 * folders deep. Skips files with unknown extensions. Throws on duplicate script names.
 */
async function scanScriptDir(
  dirPath: string,
  scripts: Map<string, ScriptDefinition>,
  depth = 0
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().debug({ dirPath }, 'script_directory_not_found');
      return;
    }
    getLog().warn({ err, dirPath }, 'script_directory_read_error');
    throw new Error(`Directory read error: ${err.message} (${err.code ?? 'unknown'})`);
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);

    let entryStat;
    try {
      entryStat = await stat(entryPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      getLog().warn({ err, entryPath }, 'script_file_stat_error');
      continue;
    }

    if (entryStat.isDirectory()) {
      // 1-depth cap: allow one level of grouping (e.g. `.archon/scripts/triage/foo.ts`)
      // but stop there. Matches the workflows/commands convention — no nested folders.
      if (depth >= MAX_SCRIPT_DISCOVERY_DEPTH) continue;
      await scanScriptDir(entryPath, scripts, depth + 1);
      continue;
    }

    const ext = extname(entry);
    const runtime = getRuntimeForExtension(ext);

    if (!runtime) {
      getLog().debug({ entryPath, ext }, 'script_unknown_extension_skipped');
      continue;
    }

    const name = basename(entry, ext);

    const existing = scripts.get(name);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate script name "${name}": found "${existing.path}" and "${entryPath}". ` +
          'Script names must be unique across extensions.'
      );
    }

    scripts.set(name, { name, path: normalizeSep(entryPath), runtime });
    getLog().debug({ name, runtime, entryPath }, 'script_loaded');
  }
}

/**
 * Discover scripts from a directory (expected to be .archon/scripts/ or equivalent).
 * Returns a Map of script name -> ScriptDefinition.
 * Throws if duplicate script names are found across different extensions within the directory.
 * Returns an empty Map if the directory does not exist.
 */
export async function discoverScripts(dir: string): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  await scanScriptDir(dir, scripts);
  getLog().info({ count: scripts.size, dir }, 'scripts_discovery_completed');
  return scripts;
}

/**
 * Discover scripts across all scopes for a given repo cwd.
 *
 * Resolution order (repo wins on same-name collision — matches the
 * workflows/commands precedence):
 *   1. `<cwd>/.archon/scripts/` — repo-scoped (`source: 'project'` equivalent)
 *   2. `~/.archon/scripts/`    — home-scoped (`source: 'global'` equivalent)
 *
 * Within a single scope, duplicate basenames across extensions still throw
 * (matches `discoverScripts` behavior). Across scopes, the repo-level entry
 * silently overrides the home-level one.
 */
export async function discoverScriptsForCwd(cwd: string): Promise<Map<string, ScriptDefinition>> {
  const homeScripts = await discoverScripts(getHomeScriptsPath());
  const repoScripts = await discoverScripts(join(cwd, '.archon', 'scripts'));

  // Start with home, overlay repo (repo wins)
  const merged = new Map<string, ScriptDefinition>(homeScripts);
  for (const [name, def] of repoScripts) {
    if (merged.has(name)) {
      getLog().debug({ name }, 'script.repo_overrides_home');
    }
    merged.set(name, def);
  }
  return merged;
}

/**
 * Returns bundled default scripts (empty — no bundled scripts for now).
 * Follows the bundled-defaults.ts pattern for future extensibility.
 */
export function getDefaultScripts(): Map<string, ScriptDefinition> {
  return new Map();
}
