/**
 * The files a run leaves on disk, and their removal once its row is gone.
 *
 * A run writes three paths under its project's storage root, all keyed by its id: its
 * artifacts directory, its JSONL log and its frozen workflow source. The store deletes
 * rows; this removes those paths for the rows it deleted (`removeRunFiles`), and finds the
 * ones whose row was deleted before anything removed them (`findOrphanRunFiles`).
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  RUN_ID_PATTERN,
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunLogPathForRoot,
  getRunWorkflowSourceDirForRoot,
  getStoragePathsForRoot,
  resolveRunStorageRoot,
} from '@archon/paths/archon-paths';
import { STAGED_SOURCE_TTL_MS } from '@archon/workflows/staged-source-ttl';
import type { DeletedWorkflowRun, IWorkflowStore } from '@archon/workflows/store';

import type { RunFilesReport } from '../../schemas/run-files';

export type { RunFilesReport };

/** Removes one path and everything under it; injected by tests to fail a removal. */
export type RemovePath = (path: string) => Promise<void>;

const removeTree: RemovePath = path => rm(path, { recursive: true, force: true });

/** The paths the engine writes for a run under its project root. */
function runPaths(root: string, runId: string): string[] {
  return [
    getRunArtifactsDirForRoot(root, runId),
    getRunLogPathForRoot(root, runId),
    getRunWorkflowSourceDirForRoot(root, runId),
  ];
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : '';
    return `${code}${error.message}`;
  }
  return String(error);
}

/** Bytes under `path`, without following symlinks. A missing path is 0. */
async function pathBytes(path: string): Promise<number> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  if (!info.isDirectory()) return info.size;
  let total = info.size;
  for (const entry of await readdir(path)) total += await pathBytes(join(path, entry));
  return total;
}

/**
 * Where a run directory (`logs/`, `artifacts/runs/`, `workflow-source/runs/`) really is.
 * It is `contained` only when it sits on disk where its name says, under the real
 * workspaces root: an operator may link a storage directory elsewhere, and a link between
 * the workspaces root and the directory would take removal outside the workspace.
 * `resolveRunStorageRoot` checks names only, so this is the check that reads the disk.
 */
async function containment(dir: string): Promise<'contained' | 'missing' | { linksTo: string }> {
  const workspaces = getArchonWorkspacesPath();
  const rel = relative(workspaces, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { linksTo: dir };
  let real: string;
  try {
    real = await realpath(dir);
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
  return real === join(await realpath(workspaces), rel) ? 'contained' : { linksTo: real };
}

/** Remove each path, adding to `report`; a failure is recorded and the rest continue. */
async function removePaths(
  paths: readonly string[],
  report: RunFilesReport,
  remove: RemovePath
): Promise<void> {
  for (const path of paths) {
    try {
      const where = await containment(dirname(path));
      if (where === 'missing') continue;
      if (where !== 'contained') {
        report.failed.push({
          path,
          error: `not removed: its directory is ${where.linksTo}, outside the project workspace`,
        });
        continue;
      }
      const bytes = await pathBytes(path);
      await remove(path);
      report.removedBytes += bytes;
    } catch (error) {
      if (!isNotFound(error)) report.failed.push({ path, error: describe(error) });
    }
  }
}

/**
 * Remove the files of runs whose rows are already deleted. Never throws for a file: a
 * failed removal is in the report with its path, and the row deletion stands.
 */
export async function removeRunFiles(
  runs: readonly DeletedWorkflowRun[],
  store: Pick<IWorkflowStore, 'getCodebase'>,
  remove: RemovePath = removeTree
): Promise<RunFilesReport> {
  const report: RunFilesReport = { removedBytes: 0, failed: [], unlocated: [] };
  for (const run of runs) {
    // The id becomes a path segment, so only a run id's shape may build one.
    if (!RUN_ID_PATTERN.test(run.id)) {
      report.unlocated.push(run.id);
      continue;
    }
    let root = resolveRunStorageRoot(run, null);
    if (!root && run.codebase_id) {
      try {
        root = resolveRunStorageRoot(run, await store.getCodebase(run.codebase_id));
      } catch (error) {
        // No path can be built without the project, so the run id stands in for one.
        report.failed.push({ path: run.id, error: `project lookup failed: ${describe(error)}` });
        continue;
      }
    }
    if (!root) {
      report.unlocated.push(run.id);
      continue;
    }
    await removePaths(runPaths(root, run.id), report, remove);
  }
  return report;
}

export interface OrphanRunFile {
  path: string;
  bytes: number;
}

export interface OrphanRunFiles {
  orphans: OrphanRunFile[];
  /** Run directories left unscanned because they link outside the workspace. */
  linked: { path: string; linksTo: string }[];
  /**
   * Paths with no row that changed within {@link ORPHAN_MIN_AGE_MS}, left for now, and when
   * the last of them is old enough to list. A removal that failed part way changes its path,
   * so its leftovers land here first.
   */
  deferred: { count: number; readyAt: Date | null };
}

/**
 * Younger than this, a run-id path may belong to a run whose row does not exist yet: a
 * container run's frozen source moves to `workflow-source/runs/<id>` before its row is
 * written. The same margin the engine gives an unadopted source capture.
 */
export const ORPHAN_MIN_AGE_MS = STAGED_SOURCE_TTL_MS;

async function directories(path: string): Promise<Dirent[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function children(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/**
 * Run-id paths under every project's run directories whose id has no row in `store`.
 * Projects sit two levels under the workspaces root (`owner/repo`, `_folder/<slug>`,
 * `@cwd/<name>`); symlinked entries are never followed, and a run directory that links
 * outside the workspace is reported in `linked`, not scanned. A path with no row that
 * changed within {@link ORPHAN_MIN_AGE_MS} is counted in `deferred`, not listed.
 */
export async function findOrphanRunFiles(
  store: Pick<IWorkflowStore, 'getWorkflowRun'>,
  now: number = Date.now()
): Promise<OrphanRunFiles> {
  const workspaces = getArchonWorkspacesPath();
  const found: OrphanRunFile[] = [];
  const linked: OrphanRunFiles['linked'] = [];
  const deferred: OrphanRunFiles['deferred'] = { count: 0, readyAt: null };
  const known = new Map<string, boolean>();
  const hasRow = async (id: string): Promise<boolean> => {
    let value = known.get(id);
    if (value === undefined) {
      value = (await store.getWorkflowRun(id)) !== null;
      known.set(id, value);
    }
    return value;
  };
  for (const owner of await directories(workspaces)) {
    for (const project of await directories(join(workspaces, owner.name))) {
      const storage = getStoragePathsForRoot(join(workspaces, owner.name, project.name));
      const parents: [string, (name: string) => string | null][] = [
        [join(storage.artifactsRoot, 'runs'), name => name],
        [join(storage.workflowSourceRoot, 'runs'), name => name],
        [storage.logsDir, name => (name.endsWith('.jsonl') ? name.slice(0, -6) : null)],
      ];
      for (const [parent, idOf] of parents) {
        const where = await containment(parent);
        if (where === 'missing') continue;
        if (where !== 'contained') {
          linked.push({ path: parent, linksTo: where.linksTo });
          continue;
        }
        for (const entry of await children(parent)) {
          if (entry.isSymbolicLink()) continue;
          const id = idOf(entry.name);
          if (id === null || !RUN_ID_PATTERN.test(id)) continue;
          const path = join(parent, entry.name);
          if (await hasRow(id)) continue;
          const info = await lstat(path);
          if (now - info.mtimeMs < ORPHAN_MIN_AGE_MS) {
            const ready = info.mtimeMs + ORPHAN_MIN_AGE_MS;
            deferred.count++;
            if (deferred.readyAt === null || ready > deferred.readyAt.getTime())
              deferred.readyAt = new Date(ready);
            continue;
          }
          found.push({ path, bytes: await pathBytes(path) });
        }
      }
    }
  }
  return { orphans: found, linked, deferred };
}

/** Remove paths {@link findOrphanRunFiles} listed, reported like {@link removeRunFiles}. */
export async function removeOrphanRunFiles(
  orphans: readonly OrphanRunFile[],
  remove: RemovePath = removeTree
): Promise<RunFilesReport> {
  const report: RunFilesReport = { removedBytes: 0, failed: [], unlocated: [] };
  await removePaths(
    orphans.map(orphan => orphan.path),
    report,
    remove
  );
  return report;
}
