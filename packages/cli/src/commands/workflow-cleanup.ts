/**
 * `archon workflow cleanup`: delete old runs with their files, or remove the files of runs
 * deleted before cleanup removed files (`--orphans`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IWorkflowStore } from '@archon/workflows/store';
import {
  ORPHAN_MIN_AGE_MS,
  findOrphanRunFiles,
  removeOrphanRunFiles,
  removeRunFiles,
  type RunFilesReport,
} from '@archon/core/services/cleanup/run-files';
import { getFileStoreRoot } from '../utils/workflow-host';
import { getLog } from './workflow-shared';

/** The store this CLI process opened: the file store, or the database `DATABASE_URL` picks. */
export type CleanupStoreKind = 'files' | 'sqlite' | 'postgresql';

async function selectedStoreKind(): Promise<CleanupStoreKind> {
  const { loadStoreSelection } = await import('@archon/core/config/store-selection');
  if ((await loadStoreSelection()) === 'files') return 'files';
  return (await import('@archon/core/db/connection')).getDatabaseType();
}

/**
 * The retry hint after a failed removal. `--orphans` waits until a path is
 * `ORPHAN_MIN_AGE_MS` past its last change, and a removal that failed part way has just
 * changed it, so the hint names that wait.
 */
function orphansRetry(now: number): string {
  const hours = String(ORPHAN_MIN_AGE_MS / 3_600_000);
  return (
    `Once the cause is fixed, \`archon workflow cleanup --orphans --yes\` removes them. It waits until a path is ${hours} hours past its last change, so paths this command touched may be listed only after ${new Date(now + ORPHAN_MIN_AGE_MS).toISOString()}. ` +
    'A path whose directory is outside the project workspace is never removed by Archon.'
  );
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${String(bytes)} B` : `${value.toFixed(1)} ${units[unit] ?? ''}`;
}

/** Print what removal left on disk to stderr; true when a path could not be removed. */
function reportLeftovers(report: RunFilesReport): boolean {
  if (report.unlocated.length > 0)
    console.log(
      `${String(report.unlocated.length)} deleted run(s) had no storage location to remove files from. ` +
        '`archon workflow cleanup --orphans` lists what they left.'
    );
  if (report.failed.length === 0) return false;
  console.error(`Could not remove ${String(report.failed.length)} path(s):`);
  for (const { path, error } of report.failed) console.error(`  ${path}: ${error}`);
  console.error(orphansRetry(Date.now()));
  return true;
}

/**
 * Delete terminal workflow runs older than the given number of days, then their artifacts,
 * logs and frozen workflow sources. Exits 1 when a path could not be removed; the rows stay
 * deleted.
 */
export async function workflowCleanupCommand(
  host: {
    deps: {
      store: Pick<IWorkflowStore, 'deleteOldWorkflowRuns' | 'pruneStateRevisions' | 'getCodebase'>;
    };
  },
  days: number
): Promise<number> {
  let deleted: number | undefined;
  let failed = false;
  try {
    const { runs } = await host.deps.store.deleteOldWorkflowRuns(days);
    deleted = runs.length;
    if (runs.length === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      const files = await removeRunFiles(runs, host.deps.store);
      console.log(
        `Deleted ${String(runs.length)} workflow run(s) older than ${days} days and removed ${formatBytes(files.removedBytes)} of their files.`
      );
      failed = reportLeftovers(files);
    }
    const { count: revisions } = await host.deps.store.pruneStateRevisions(days);
    console.log(`Pruned ${revisions} state revision(s) older than ${days} days.`);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days, deleted }, 'cli.workflow_cleanup_failed');
    if (deleted !== undefined)
      throw new Error(
        `Deleted ${deleted} workflow run(s) older than ${days} days, but failed to prune state revisions: ${err.message}`,
        { cause: error }
      );
    throw new Error(`Failed to clean up workflow history: ${err.message}`, { cause: error });
  }
  return failed ? 1 : 0;
}

/**
 * Another store history on this ARCHON_HOME. Switching stores keeps the old one, and its
 * runs have no row in the open store, so their files would read as orphans here.
 */
async function otherStoreHistory(kind: CleanupStoreKind): Promise<string | undefined> {
  // Loaded here so a file-store install does not load the database adapters to list files.
  const { getSqliteDbPath } = await import('@archon/core/db/connection');
  const sqlitePath = getSqliteDbPath();
  const sqlite = existsSync(sqlitePath) ? `a SQLite database (${sqlitePath})` : '';
  const fileStorePath = join(getFileStoreRoot(), 'head.json');
  const files = existsSync(fileStorePath) ? `a file store (${getFileStoreRoot()})` : '';
  const others = kind === 'files' ? [sqlite] : kind === 'sqlite' ? [files] : [sqlite, files];
  return others.filter(Boolean).join(' and ') || undefined;
}

/**
 * List run-id paths whose run has no row in the open store, with their sizes. With `yes`,
 * remove them, unless this ARCHON_HOME holds another store's history.
 */
export async function workflowOrphanCleanupCommand(
  host: { deps: { store: Pick<IWorkflowStore, 'getWorkflowRun'> } },
  options: { yes: boolean; storeKind?: CleanupStoreKind }
): Promise<number> {
  const { orphans, linked, deferred } = await findOrphanRunFiles(host.deps.store);
  for (const { path, linksTo } of linked)
    console.log(`Skipped ${path}: it is ${linksTo}, outside the project workspace.`);
  if (deferred.count > 0 && deferred.readyAt)
    console.log(
      `Left ${String(deferred.count)} path(s) of runs with no row for now: each changed in the last ${String(ORPHAN_MIN_AGE_MS / 3_600_000)} hours and may belong to a run being created. Run again after ${deferred.readyAt.toISOString()} to list them.`
    );
  if (orphans.length === 0) {
    if (deferred.count === 0) console.log('No files of deleted runs found.');
    return 0;
  }
  for (const { path, bytes } of orphans) console.log(`${formatBytes(bytes)}\t${path}`);
  const total = orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);
  console.log(
    `Found ${String(orphans.length)} path(s), ${formatBytes(total)}, of runs this store has no row for.`
  );
  if (!options.yes) {
    console.log('Nothing was removed. Run again with --yes to remove them.');
    return 0;
  }
  const other = await otherStoreHistory(options.storeKind ?? (await selectedStoreKind()));
  if (other) {
    console.error(
      `Refusing to remove: this ARCHON_HOME also holds ${other}. Its runs have no row in the ` +
        'store this command opened, so their files are in the list above. Move that history ' +
        'out of ARCHON_HOME first, or remove the paths you have checked by hand.'
    );
    return 1;
  }
  const report = await removeOrphanRunFiles(orphans);
  console.log(`Removed ${formatBytes(report.removedBytes)}.`);
  return reportLeftovers(report) ? 1 : 0;
}
