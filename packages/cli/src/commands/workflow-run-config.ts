import { isAbsolute, join } from 'node:path';
import {
  itemRunConfig,
  loadWorkflowRunConfigFile,
  normalizeRunConfigSemantics,
  workflowRunConfigFromRun,
} from '@archon/core/config';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { registeredProjectKeyForPath } from '@archon/core/services/codebase-checkout-resolver';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import { resolveRunIdArg, type WorkflowRunOptions } from './workflow-shared';

/**
 * The run config layer a launch starts with: the sealed layer a detached parent handed
 * its child, the layer another run started with (`--config-from-run`), a `--config`
 * file, or else, for a fresh start on an item, the layer the item's most recent run
 * started with. A continuation restores its own recorded layer, so it takes none of these.
 */
export async function resolveLaunchRunConfig(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  cwd: string,
  isContinuation: boolean
): Promise<WorkflowRunConfigInput | undefined> {
  const configPath = options.configPath
    ? isAbsolute(options.configPath)
      ? options.configPath
      : join(cwd, options.configPath)
    : undefined;
  if (isContinuation && (configPath || options.configFromRun || options.detachedRunConfig)) {
    throw new Error('A continued run keeps its original run config; it takes no new one.');
  }
  if (configPath && options.configFromRun) {
    throw new Error('--config and --config-from-run are mutually exclusive.');
  }
  // A detached child always receives the layer its parent resolved, never the flag again.
  if (options.detachedRunConfig) {
    return {
      ...options.detachedRunConfig,
      layer: normalizeRunConfigSemantics(options.detachedRunConfig.layer),
    };
  }
  if (options.configFromRun) {
    const runId = await resolveRunIdArg(host, options.configFromRun);
    const run = await host.deps.store.getWorkflowRun(runId);
    if (!run) throw new Error(`--config-from-run: no workflow run '${options.configFromRun}'.`);
    return workflowRunConfigFromRun(run);
  }
  if (configPath) return await loadWorkflowRunConfigFile(configPath);
  return await itemLaunchRunConfig(host, options, cwd);
}

/**
 * The config of the item a fresh start is on, so a start that names no config keeps the
 * one the item runs on instead of silently dropping it. The item is the one `--item` names
 * in the project of `cwd`, else that of the run `--supersedes` names, which the start
 * inherits. An adoption inherits the adopted run's AI configuration instead.
 */
async function itemLaunchRunConfig(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  cwd: string
): Promise<WorkflowRunConfigInput | undefined> {
  if (options.adoptRunId) return undefined;
  let item: { projectKey: string; key: string } | null = null;
  if (options.item) {
    const projectKey = await registeredProjectKeyForPath(cwd, host.records.codebases);
    // No registered project means no item yet: the run registers it and writes the item.
    item = projectKey ? { projectKey, key: options.item } : null;
  } else if (options.supersedesRunId) {
    const superseded = await host.deps.store.getWorkflowRun(
      await resolveRunIdArg(host, options.supersedesRunId)
    );
    item = superseded?.item_id ? await host.deps.store.getItem(superseded.item_id) : null;
  }
  if (!item) return undefined;
  const found = await host.deps.store.getItemRuns(item.projectKey, item.key);
  return found ? itemRunConfig(item.key, found.runs) : undefined;
}
