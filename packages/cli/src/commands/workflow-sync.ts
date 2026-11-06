import { loadConfig } from '@archon/core/config/config-loader';
import { syncExtraSource, type ExtraSourceSyncResult } from '@archon/workflows/extra-sources';
import { writeJsonLine, writeStdout } from '../utils/stdout';

export interface WorkflowSyncOptions {
  json?: boolean;
}

/**
 * `archon workflow sync`: refresh the snapshots of the project's `extraWorkflowSources`.
 * Runs only when asked, and a run never does it for you: a run uses the last snapshot.
 */
export async function workflowSyncCommand(
  projectRoot: string,
  options: WorkflowSyncOptions
): Promise<number> {
  const config = await loadConfig(projectRoot);
  const sources = config.extraWorkflowSources ?? [];
  const results: ExtraSourceSyncResult[] = [];
  for (const source of sources) {
    results.push(await syncExtraSource(projectRoot, source, config.remote));
  }

  if (options.json) {
    await writeJsonLine({
      ok: true,
      sources: results.map(({ source, commit, fetched, files }) => ({
        ref: source.ref,
        path: source.path,
        commit,
        fetched,
        files,
      })),
    });
    return 0;
  }
  if (results.length === 0) {
    await writeStdout('No extraWorkflowSources are configured in .archon/config.yaml.\n');
    return 0;
  }
  for (const { source, commit, fetched, files } of results) {
    const where = source.path === '.' ? source.ref : `${source.ref}:${source.path}`;
    await writeStdout(
      `${where} -> ${commit.slice(0, 12)} (${fetched ? 'fetched' : 'read locally, no remote'}, ${files} files)\n`
    );
  }
  return 0;
}
