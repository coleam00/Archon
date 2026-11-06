import {
  readExtraSourceSnapshot,
  syncExtraSource,
  type ExtraSourceSnapshotMeta,
  type ExtraSourceSyncResult,
} from '@archon/workflows/extra-sources';
import type { ExtraWorkflowSource } from '@archon/workflows/schemas/run-metadata';
import { loadConfig } from '../config/config-loader';

/** One configured extra workflow source and what was last synced for it. */
export interface ExtraSourceStatus {
  source: ExtraWorkflowSource;
  /** Null when the source has never been synced. */
  snapshot: ExtraSourceSnapshotMeta | null;
}

/** The project's `extraWorkflowSources` with the snapshot each one currently has. */
export async function listExtraSources(projectRoot: string): Promise<ExtraSourceStatus[]> {
  const config = await loadConfig(projectRoot);
  const statuses: ExtraSourceStatus[] = [];
  for (const source of config.extraWorkflowSources ?? []) {
    const snapshot = await readExtraSourceSnapshot(projectRoot, source);
    statuses.push({ source, snapshot: snapshot?.meta ?? null });
  }
  return statuses;
}

/**
 * Refresh every configured extra workflow source, in config order. The first failure
 * stops the sync and propagates; sources before it keep their new snapshots.
 */
export async function syncConfiguredExtraSources(
  projectRoot: string
): Promise<ExtraSourceSyncResult[]> {
  const config = await loadConfig(projectRoot);
  const results: ExtraSourceSyncResult[] = [];
  for (const source of config.extraWorkflowSources ?? []) {
    results.push(await syncExtraSource(projectRoot, source, config.remote));
  }
  return results;
}
