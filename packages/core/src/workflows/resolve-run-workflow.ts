import { loadConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';
import { resolveContinuationWorkflow } from '@archon/workflows/executor';
import { resolveWorkflowName } from '@archon/workflows/router';
import type { ResolvedWorkflow, WorkflowLoadError } from '@archon/workflows/schemas/workflow';
import { spellWorkflowCommand, type WorkflowCommandSurface } from '@archon/workflows/deps';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { createWorkflowDeps } from './store-adapter';
import { toError } from '../utils/error';

const log = createLogger('resolve-run-workflow');

function findWorkflowLoadError(
  loadErrors: readonly WorkflowLoadError[],
  workflowName: string
): WorkflowLoadError | undefined {
  return loadErrors.find(error => error.filename.replace(/\.ya?ml$/, '') === workflowName);
}

export async function resolveRunWorkflow(
  run: WorkflowRun,
  workflowCwd: string,
  surface: WorkflowCommandSurface
): Promise<
  { ok: true; workflow: ResolvedWorkflow } | { ok: false; message: string; resumeHint?: string }
> {
  try {
    const continuation = await resolveContinuationWorkflow(createWorkflowDeps(), run, workflowCwd);
    if (continuation) return { ok: true, workflow: continuation.workflow };
  } catch (error) {
    const err = toError(error);
    log.error({ err, runId: run.id }, 'workflow.continuation_source_failed');
    return {
      ok: false,
      message: `its recorded workflow source is unavailable: ${err.message}`,
      resumeHint: 'Start a fresh run to execute the current workflow.',
    };
  }

  let discovery: Awaited<ReturnType<typeof discoverWorkflowsWithConfig>>;
  try {
    discovery = await discoverWorkflowsWithConfig(workflowCwd, loadConfig);
  } catch (error) {
    const err = toError(error);
    log.error({ err, cwd: workflowCwd, runId: run.id }, 'workflow.resume_discovery_failed');
    return {
      ok: false,
      message: `Failed to load workflows: ${err.message}\n\nCheck .archon/workflows/ for YAML syntax issues.`,
    };
  }

  const workflow = resolveWorkflowName(
    run.workflow_name,
    discovery.workflows.map(entry => entry.workflow)
  );
  if (workflow) return { ok: true, workflow };

  const loadError = findWorkflowLoadError(discovery.errors, run.workflow_name);
  if (loadError) {
    return {
      ok: false,
      message: `Workflow \`${run.workflow_name}\` failed to load: ${loadError.error}\n\nFix the YAML file and try again.`,
    };
  }
  return {
    ok: false,
    message:
      `Workflow \`${run.workflow_name}\` for run ${run.id} was not found.\n\n` +
      `Use ${spellWorkflowCommand(surface, 'list')} to check available workflows.`,
  };
}
