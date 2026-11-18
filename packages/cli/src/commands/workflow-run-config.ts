import { isAbsolute, join } from 'node:path';
import {
  itemRunConfig,
  loadWorkflowRunConfigFile,
  normalizeRunConfigSemantics,
  workflowRunConfigFromRun,
} from '@archon/core/config';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { resolveRunLanding } from '@archon/core/workflows/item-landing';
import type { Codebase } from '@archon/core/schemas/codebase';
import { landingSourceText } from '@archon/workflows/item-landing';
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
  const found = await launchItemRuns(host, options.item, options.supersedesRunId, cwd);
  return found ? itemRunConfig(found.item.key, found.runs) : undefined;
}

/**
 * The item a fresh start is on and its runs: the one `--item` names in the project of
 * `cwd`, else that of the run it continues (`--supersedes` or `--adopt`), which the start
 * inherits. Null when there is no such item yet.
 */
async function launchItemRuns(
  host: WorkflowHost,
  itemKey: string | undefined,
  continuedRunId: string | undefined,
  cwd: string
): Promise<Awaited<ReturnType<WorkflowHost['deps']['store']['getItemRuns']>>> {
  let item: { projectKey: string; key: string } | null = null;
  if (itemKey) {
    const projectKey = await registeredProjectKeyForPath(cwd, host.records.codebases);
    // No registered project means no item yet: the run registers it and writes the item.
    item = projectKey ? { projectKey, key: itemKey } : null;
  } else if (continuedRunId) {
    // Resolved within the launch project, as the continuation itself resolves it: a short
    // prefix passed through unresolved would find no run and silently drop the item.
    const continued = await host.deps.store.getWorkflowRun(
      await resolveRunIdArg(host, continuedRunId, cwd)
    );
    item = continued?.item_id ? await host.deps.store.getItem(continued.item_id) : null;
  }
  return item ? host.deps.store.getItemRuns(item.projectKey, item.key) : null;
}

/**
 * The base a fresh launch is cut from and proposes against, and where it came from:
 * `--base`, else the landing branch of the item it starts on (its own, or the nearest
 * item it is `part_of`). Undefined leaves the base to repo config, the codebase default
 * and detection. A continuation keeps the base it recorded, so it takes neither.
 */
export interface LaunchBase {
  branch: string;
  /** For a reader: `--base`, or which item's landing branch. */
  source: string;
}

/** Throws when the item's landing branch is missing on the remote or cannot be resolved. */
export async function resolveLaunchBase(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  cwd: string,
  admission: { isContinuation: boolean; flagBase: string | undefined },
  codebase: Codebase | null
): Promise<LaunchBase | undefined> {
  if (admission.flagBase) return { branch: admission.flagBase, source: '--base' };
  if (admission.isContinuation || codebase === null) return undefined;
  const found = await launchItemRuns(
    host,
    options.item,
    options.supersedesRunId ?? options.adoptRunId,
    cwd
  );
  if (!found) return undefined;
  const landing = await resolveRunLanding(host.deps.store, codebase, found.item);
  if (!landing) return undefined;
  return {
    branch: landing.branch,
    source: `landing branch of item ${found.item.key}, ${landingSourceText(landing)}`,
  };
}
