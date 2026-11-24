import { isAbsolute, join } from 'node:path';
import {
  itemRunConfig,
  loadWorkflowRunConfigFile,
  normalizeRunConfigSemantics,
  workflowRunConfigFromRun,
} from '@archon/core/config';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { refuseInPlaceLanding, resolveRunLanding } from '@archon/core/workflows/item-landing';
import { projectRefForCodebase } from '@archon/core/operations/attention-queue';
import type { Codebase } from '@archon/core/schemas/codebase';
import { landingSourceText } from '@archon/workflows/item-landing';
import { projectKeyForCodebase } from '@archon/paths';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { WorkflowItem } from '@archon/workflows/schemas/workflow-run';
import { findLaunchCodebase } from './workflow-isolation';
import type { ContinuationDeclaration } from './workflow-run-preflight';
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
 * in the start's project, else that of the run `--supersedes` names, which the start
 * inherits. The start's project comes from `findLaunchCodebase`, the lookup the run row
 * (and so the item it is written onto) takes its project from, so `--project` selects the
 * item here too. An adoption inherits the adopted run's AI configuration instead.
 */
async function itemLaunchRunConfig(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  cwd: string
): Promise<WorkflowRunConfigInput | undefined> {
  if (options.adoptRunId || !(options.item || options.supersedesRunId)) return undefined;
  const { codebase } = await findLaunchCodebase(host, cwd, options);
  // No registered project means no item yet: the run registers it and writes the item.
  // (A supersession outside a registered project is refused by the run itself.)
  if (!codebase) return undefined;
  let item: { projectKey: string; key: string } | null = null;
  if (options.item) {
    item = { projectKey: projectKeyForCodebase(codebase, codebase.default_cwd), key: options.item };
  } else if (options.supersedesRunId) {
    // Resolved within the launch project, as the supersession itself resolves it: a short
    // prefix passed through unresolved would find no run and silently drop the config.
    const superseded = await host.deps.store.getWorkflowRun(
      await resolveRunIdArg(host, options.supersedesRunId, undefined, false, codebase.id)
    );
    item = superseded?.item_id ? await host.deps.store.getItem(superseded.item_id) : null;
  }
  if (!item) return undefined;
  const found = await host.deps.store.getItemRuns(item.projectKey, item.key);
  return found ? itemRunConfig(item.key, found.runs) : undefined;
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

/**
 * Throws when the item's landing branch is missing on the remote or cannot be resolved, or
 * when the run would work in place, where it cannot be cut from the branch. An adoption
 * continues the adopted run's checkout, which keeps its own cut-from, as a hand-off does.
 */
export async function resolveLaunchBase(
  host: WorkflowHost,
  item: string | undefined,
  admission: { isContinuation: boolean; flagBase: string | undefined; wantsIsolation: boolean },
  codebase: Codebase | null,
  declaration: ContinuationDeclaration | undefined
): Promise<LaunchBase | undefined> {
  if (admission.flagBase) return { branch: admission.flagBase, source: '--base' };
  if (admission.isContinuation || codebase === null) return undefined;
  const found = await launchItem(host, item, codebase, declaration);
  if (!found) return undefined;
  const landing = await resolveRunLanding(host.deps.store, codebase, found);
  if (!landing) return undefined;
  if (!admission.wantsIsolation && !(declaration && 'lane' in declaration))
    refuseInPlaceLanding(found, landing);
  return {
    branch: landing.branch,
    source: `landing branch of item ${found.key}, ${landingSourceText(landing)}`,
  };
}

/**
 * The item a fresh launch is recorded on: `--item` in the selected project (which
 * `--project` may choose apart from the directory the command runs in), else the item of
 * the run the declared `--supersedes` or `--adopt` continues. Null when there is none yet.
 */
async function launchItem(
  host: WorkflowHost,
  item: string | undefined,
  codebase: Codebase,
  declaration: ContinuationDeclaration | undefined
): Promise<WorkflowItem | null> {
  const { store } = host.deps;
  if (item)
    return (await store.getItemRuns(projectRefForCodebase(codebase).key, item))?.item ?? null;
  if (!declaration) return null;
  const continued = await store.getWorkflowRun(declaration.runId);
  return continued?.item_id ? store.getItem(continued.item_id) : null;
}
