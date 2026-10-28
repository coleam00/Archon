import { isAbsolute, join } from 'node:path';
import {
  loadWorkflowRunConfigFile,
  normalizeRunConfigSemantics,
  workflowRunConfigFromRun,
} from '@archon/core/config';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import { RESUME_RUN_CONFIG_CONFLICT } from '../dispatch-guards';
import { resolveRunIdArg, type WorkflowRunOptions } from './workflow-shared';

/**
 * The run config layer a launch starts with: the sealed layer a detached parent handed
 * its child, the layer another run started with (`--config-from-run`), or a `--config`
 * file. A continuation restores its own recorded layer, so it takes none of these.
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
  if (isContinuation && options.configFromRun) {
    throw new Error(
      '--resume and --config-from-run are mutually exclusive. A resumed run keeps its original run config.'
    );
  }
  if (isContinuation && (configPath || options.detachedRunConfig)) {
    throw new Error(RESUME_RUN_CONFIG_CONFLICT);
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
  return configPath ? await loadWorkflowRunConfigFile(configPath) : undefined;
}
