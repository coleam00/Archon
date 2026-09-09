/**
 * Discover shared scripts and workflow-local packaged scripts.
 *
 * Shared scripts from `.archon/scripts/` are keyed by filename without an
 * extension. Packaged scripts live under
 * `.archon/workflows/<pack>/<workflow>/scripts/` and receive owner-qualified
 * internal keys. Runtime is inferred from the extension: .ts/.js -> bun,
 * .py -> uv.
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { join, basename, dirname, extname } from 'path';
import { createLogger, getArchonHome } from '@archon/paths';
import { BUNDLED_SCRIPT_PACKS, isBinaryBuild } from './defaults/bundled-defaults';
import { liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import {
  formatPackagedResourceReference,
  getPackagedResourceDirectory,
  isValidWorkflowFolderSegment,
  parsePackagedResourceReference,
} from './packaged-workflow';
import type { WorkflowSource } from './schemas';

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
 * We stop at 1 deliberately — deeper nesting has never been part of the
 * documented convention and adds no organizational value, just routing
 * ambiguity when two basenames collide across folders.
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

async function discoverPackagedScripts(
  workflowsRoot: string,
  source: WorkflowSource
): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return scripts;
    throw error;
  }

  for (const pack of packs) {
    if (!isValidWorkflowFolderSegment(pack)) continue;
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue;
      throw new Error(`Failed to inspect packaged workflow pack "${packPath}": ${err.message}`, {
        cause: err,
      });
    }
    let workflowFolders: string[];
    try {
      workflowFolders = await readdir(packPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue;
      throw new Error(`Failed to read packaged workflow pack "${packPath}": ${err.message}`, {
        cause: err,
      });
    }
    for (const workflow of workflowFolders) {
      if (!isValidWorkflowFolderSegment(workflow)) continue;
      try {
        if (!(await stat(join(packPath, workflow))).isDirectory()) continue;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') continue;
        throw new Error(
          `Failed to inspect packaged workflow "${join(packPath, workflow)}": ${err.message}`,
          { cause: err }
        );
      }
      const owner = { source, pack, workflow };
      const localScripts = await discoverScripts(
        getPackagedResourceDirectory(workflowsRoot, owner, 'scripts')
      );
      for (const [name, definition] of localScripts) {
        const qualifiedName = formatPackagedResourceReference(owner, name);
        scripts.set(qualifiedName, { ...definition, name: qualifiedName });
      }
    }
  }
  return scripts;
}

async function materializeBundledScripts(): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  for (const [pack, bundled] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
    const files = Object.entries(bundled.files).sort(([a], [b]) => a.localeCompare(b));
    const contentHash = createHash('sha256')
      .update(JSON.stringify(files))
      .digest('hex')
      .slice(0, 16);
    const packCache = join(getArchonHome(), 'cache', 'workflow-scripts', pack);
    const unitDir = join(packCache, contentHash);
    let exists = false;
    try {
      if (!(await stat(unitDir)).isDirectory()) {
        throw new Error(`Bundled script cache is not a directory: ${unitDir}`);
      }
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!exists) {
      // Publish the complete tree at once; another discovery must never see half a pack.
      const staging = `${unitDir}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(staging, { recursive: true });
        for (const [relativePath, content] of files) {
          const target = join(staging, relativePath);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, 'utf-8');
        }
        try {
          await rename(staging, unitDir);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windows reports EPERM for an existing directory. Accept a competing
          // publisher only when its complete unit is present; other permission
          // failures must retain the original rename error.
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
          const published = await stat(unitDir).then(
            info => info.isDirectory(),
            () => false
          );
          if (!published) throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    for (const [name, entry] of Object.entries(bundled.scripts)) {
      const packaged = parsePackagedResourceReference(name);
      if (packaged?.owner.source !== 'bundled' || packaged.owner.pack !== pack) {
        throw new Error(`Invalid bundled packaged script key: ${name}`);
      }
      scripts.set(name, {
        name,
        path: normalizeSep(join(unitDir, entry.path)),
        runtime: entry.runtime,
      });
    }
  }
  return scripts;
}

async function discoverBundledPackagedScripts(
  roots: WorkflowSourceRoots
): Promise<Map<string, ScriptDefinition>> {
  // A captured run reads the bundled scripts IT froze — the capture materialized a
  // binary's embedded ones to files, so the filesystem path serves both builds.
  return isBinaryBuild() && roots.kind === 'live'
    ? await materializeBundledScripts()
    : await discoverPackagedScripts(roots.bundledWorkflows, 'bundled');
}

/**
 * Discover scripts across all scopes for a given repo cwd.
 *
 * `sourceRoots` overrides where EVERY scope is read from — a run passes the roots of its
 * frozen capture so a statically included global or bundled script cannot change under it.
 *
 * Shared bare-name scripts use repo-over-home precedence. Packaged scripts
 * are owner-qualified and merge without participating in that override rule.
 * Sources are bundled packages, home shared/package scripts, then repo
 * shared/package scripts.
 *
 * Within a single shared scope, duplicate basenames across extensions still
 * throw (matches `discoverScripts` behavior).
 */
export async function discoverScriptsForCwd(
  cwd: string,
  sourceRoots?: WorkflowSourceRoots
): Promise<Map<string, ScriptDefinition>> {
  // Scripts are executable SOURCE, so they resolve under the roots the workflow was read
  // from, not the workspace it acts on. Omitting `sourceRoots` reads live off `cwd`,
  // which is both the in-place case and the pre-capture behavior.
  const roots = sourceRoots ?? liveSourceRoots(cwd);
  const bundledPackagedScripts = await discoverBundledPackagedScripts(roots);
  const homeScripts = await discoverScripts(roots.globalScripts);
  const homePackagedScripts = await discoverPackagedScripts(roots.globalWorkflows, 'global');
  const repoScripts = roots.project
    ? await discoverScripts(join(roots.project, '.archon', 'scripts'))
    : new Map<string, ScriptDefinition>();
  const repoPackagedScripts = roots.project
    ? await discoverPackagedScripts(join(roots.project, '.archon', 'workflows'), 'project')
    : new Map<string, ScriptDefinition>();

  // Internal packaged keys include their scope, so included workflows retain
  // exact ownership. Legacy shared scripts keep repo-over-home precedence.
  const merged = new Map<string, ScriptDefinition>(bundledPackagedScripts);
  for (const [name, def] of homeScripts) merged.set(name, def);
  for (const [name, def] of homePackagedScripts) merged.set(name, def);
  for (const [name, def] of repoScripts) {
    if (merged.has(name)) {
      getLog().debug({ name }, 'script.repo_overrides_home');
    }
    merged.set(name, def);
  }
  for (const [name, def] of repoPackagedScripts) merged.set(name, def);
  return merged;
}

/**
 * Returns bundled default scripts (empty — no bundled scripts for now).
 * Follows the bundled-defaults.ts pattern for future extensibility.
 */
export function getDefaultScripts(): Map<string, ScriptDefinition> {
  return new Map();
}
