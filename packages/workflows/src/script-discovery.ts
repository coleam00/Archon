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
import { collectInstalledBundleSources } from './defaults/bundle-inventory';
import { listInstalledPacks, liveSourceRoots, type WorkflowSourceRoots } from './workflow-source';
import {
  formatPackagedResourceReference,
  isValidWorkflowFolderSegment,
  parsePackagedResourceReference,
} from './packaged-workflow';
import { FIXTURES_DIR } from './fixture-layout';
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
 *
 * With `requestedNames`, only those scripts are selected. Groups are still traversed,
 * including links whose target kind is known only after `stat`.
 */
async function scanScriptDir(
  dirPath: string,
  scripts: Map<string, ScriptDefinition>,
  depth = 0,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<void> {
  /** The runtime of a script this scan selects; undefined for any other entry. */
  const selectedRuntime = (entry: string): ScriptRuntime | undefined => {
    const ext = extname(entry);
    if (requestedNames && !requestedNames.has(basename(entry, ext))) return undefined;
    return getRuntimeForExtension(ext);
  };
  let entries: string[];
  try {
    entries = requestedNames
      ? (await readdir(dirPath, { withFileTypes: true }))
          .filter(
            entry => entry.isDirectory() || entry.isSymbolicLink() || selectedRuntime(entry.name)
          )
          .map(entry => entry.name)
      : await readdir(dirPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      onMissing?.(dirPath, error);
      getLog().debug({ dirPath }, 'script_directory_not_found');
      return;
    }
    getLog().warn({ err, dirPath }, 'script_directory_read_error');
    throw error;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    const runtime = selectedRuntime(entry);

    let entryStat;
    try {
      entryStat = await stat(entryPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        onMissing?.(entryPath, error);
        continue;
      }
      // A failure on the selected script must surface: skipping it would report the
      // script as missing. Any other entry (an unrelated or looping link) is not this
      // lookup's concern and must not invalidate it.
      if (runtime) {
        getLog().warn({ err, entryPath }, 'script_file_stat_error');
        throw error;
      }
      getLog().debug({ err, entryPath }, 'script_unrelated_entry_stat_skipped');
      continue;
    }

    if (entryStat.isDirectory()) {
      // 1-depth cap: allow one level of grouping (e.g. `.archon/scripts/triage/foo.ts`)
      // but stop there. Matches the workflows/commands convention — no nested folders.
      if (depth >= MAX_SCRIPT_DISCOVERY_DEPTH) continue;
      await scanScriptDir(entryPath, scripts, depth + 1, requestedNames, onMissing);
      continue;
    }

    if (!runtime) {
      getLog().debug({ entryPath }, 'script_entry_skipped');
      continue;
    }

    const name = basename(entry, extname(entry));

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
export async function discoverScripts(
  dir: string,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  await scanScriptDir(dir, scripts, 0, requestedNames, onMissing);
  getLog().info({ count: scripts.size, dir }, 'scripts_discovery_completed');
  return scripts;
}

async function discoverPackagedScripts(
  workflowsRoot: string,
  source: WorkflowSource,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  let packs: string[];
  try {
    packs = await readdir(workflowsRoot);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      onMissing?.(workflowsRoot, error);
      return scripts;
    }
    throw error;
  }

  for (const pack of packs) {
    if (pack === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(pack)) continue;
    if (
      requestedNames &&
      ![...requestedNames].some(name => {
        const ref = parsePackagedResourceReference(name);
        return ref?.owner.source === source && ref.owner.pack === pack;
      })
    )
      continue;
    const packPath = join(workflowsRoot, pack);
    try {
      if (!(await stat(packPath)).isDirectory()) continue;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        onMissing?.(packPath, error);
        continue;
      }
      throw new Error(`Failed to inspect packaged workflow pack "${packPath}": ${err.message}`, {
        cause: err,
      });
    }
    await discoverPackScripts(packPath, pack, source, scripts, requestedNames, onMissing);
  }
  return scripts;
}

/** Add one pack's per-workflow scripts to `scripts`, owner-qualified. */
async function discoverPackScripts(
  packPath: string,
  pack: string,
  source: WorkflowSource,
  scripts: Map<string, ScriptDefinition>,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<void> {
  let workflowFolders: string[];
  try {
    workflowFolders = await readdir(packPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      onMissing?.(packPath, error);
      return;
    }
    throw new Error(`Failed to read packaged workflow pack "${packPath}": ${err.message}`, {
      cause: err,
    });
  }
  for (const workflow of workflowFolders) {
    if (workflow === FIXTURES_DIR) continue;
    if (!isValidWorkflowFolderSegment(workflow)) continue;
    const localNames =
      requestedNames &&
      new Set(
        [...requestedNames].flatMap(name => {
          const ref = parsePackagedResourceReference(name);
          return ref?.owner.source === source &&
            ref.owner.pack === pack &&
            ref.owner.workflow === workflow
            ? [ref.name]
            : [];
        })
      );
    if (localNames?.size === 0) continue;
    try {
      if (!(await stat(join(packPath, workflow))).isDirectory()) continue;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        onMissing?.(join(packPath, workflow), error);
        continue;
      }
      throw new Error(
        `Failed to inspect packaged workflow "${join(packPath, workflow)}": ${err.message}`,
        { cause: err }
      );
    }
    const owner = { source, pack, workflow };
    const localScripts = await discoverScripts(
      join(packPath, workflow, 'scripts'),
      localNames,
      onMissing
    );
    for (const [name, definition] of localScripts) {
      const qualifiedName = formatPackagedResourceReference(owner, name);
      scripts.set(qualifiedName, { ...definition, name: qualifiedName });
    }
  }
}

/** Installed packs' scripts, from the same receipts or capture discovery reads. */
async function discoverInstalledPackScripts(
  roots: WorkflowSourceRoots,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<Map<string, ScriptDefinition>> {
  const scripts = new Map<string, ScriptDefinition>();
  for (const pack of (await listInstalledPacks(roots.installed)).packs) {
    await discoverPackScripts(pack.dir, pack.key, 'installed', scripts, requestedNames, onMissing);
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
  roots: WorkflowSourceRoots,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<Map<string, ScriptDefinition>> {
  // A captured run reads the bundled scripts IT froze — the capture materialized a
  // binary's embedded ones to files, so the filesystem path serves both builds.
  if (roots.kind === 'captured')
    return discoverPackagedScripts(roots.bundledWorkflows, 'bundled', requestedNames, onMissing);
  if (isBinaryBuild()) return materializeBundledScripts();
  const files = (await collectInstalledBundleSources(roots.bundledWorkflows)) ?? [];
  const scripts = new Map<string, ScriptDefinition>();
  for (const file of files) {
    if (file.kind !== 'pack-file' || file.entry === undefined) continue;
    scripts.set(file.entry.name, {
      name: file.entry.name,
      path: normalizeSep(file.sourcePath),
      runtime: file.entry.runtime,
    });
  }
  return scripts;
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
  sourceRoots?: WorkflowSourceRoots,
  requestedNames?: ReadonlySet<string>,
  onMissing?: (path: string, error: unknown) => void
): Promise<Map<string, ScriptDefinition>> {
  // Scripts are executable SOURCE, so they resolve under the roots the workflow was read
  // from, not the workspace it acts on. Omitting `sourceRoots` reads live off `cwd`,
  // which is both the in-place case and the pre-capture behavior.
  const roots = sourceRoots ?? liveSourceRoots(cwd);
  const sharedNames =
    requestedNames &&
    new Set([...requestedNames].filter(name => !parsePackagedResourceReference(name)));
  const sharedScripts = (dir: string) =>
    sharedNames?.size === 0
      ? Promise.resolve(new Map<string, ScriptDefinition>())
      : discoverScripts(dir, sharedNames, onMissing);
  const bundledPackagedScripts = await discoverBundledPackagedScripts(
    roots,
    requestedNames,
    onMissing
  );
  const homeScripts = await sharedScripts(roots.globalScripts);
  const homePackagedScripts = await discoverPackagedScripts(
    roots.globalWorkflows,
    'global',
    requestedNames,
    onMissing
  );
  const repoScripts = roots.project
    ? await sharedScripts(join(roots.project, '.archon', 'scripts'))
    : new Map<string, ScriptDefinition>();
  const repoPackagedScripts = roots.project
    ? await discoverPackagedScripts(
        join(roots.project, '.archon', 'workflows'),
        'project',
        requestedNames,
        onMissing
      )
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
  for (const [name, def] of await discoverInstalledPackScripts(roots, requestedNames, onMissing))
    merged.set(name, def);
  return merged;
}
