/**
 * The workflow a trigger binding starts. A fire and `archon trigger check` both choose it
 * here, so a binding the fire refuses is the binding the check reports, for the same reason.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  findWorkflowLoadError,
  type ResolvedWorkflow,
  type WorkflowLoadResult,
} from '@archon/workflows/schemas/workflow';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';

export type StartedWorkflow = { workflow: ResolvedWorkflow } | { refused: string };

/**
 * Without `discoveryCwd` the name resolves across every scope. With it, the workflow must
 * come from `<discoveryCwd>/.archon/workflows`: another scope's copy of the same name would
 * run while the run records the directory as its source (#5853). Commands, scripts and
 * composed workflows may still resolve from other scopes; the started workflow may not.
 * A refused name with a load error reports that error: the file exists but does not load.
 */
export function selectStartedWorkflow(
  launch: Pick<ResourceStartBindingIntent['launch'], 'workflowName' | 'discoveryCwd'>,
  discovered: Pick<WorkflowLoadResult, 'workflows' | 'errors'>
): StartedWorkflow {
  const { workflowName, discoveryCwd } = launch;
  const workflow = resolveWorkflowName(
    workflowName,
    discovered.workflows.map(entry => entry.workflow)
  );
  const scope = discovered.workflows.find(entry => entry.workflow === workflow)?.source;
  if (workflow && (discoveryCwd === undefined || scope === 'project')) return { workflow };
  const loadError = findWorkflowLoadError(discovered.errors, workflowName);
  if (loadError)
    return { refused: `workflow '${workflowName}' failed to load: ${loadError.error}` };
  if (discoveryCwd === undefined)
    return { refused: `workflow '${workflowName}' is not in this project` };
  const root = resolve(discoveryCwd);
  const checkout = checkoutRootAbove(root);
  return {
    refused:
      `workflow '${workflowName}' is not in the binding's workflow source ${root}: Archon looked in ` +
      `${join(root, '.archon', 'workflows')}` +
      (scope ? ` and found it only in the ${scope} scope` : '') +
      (checkout === undefined
        ? ''
        : `; launch.discoveryCwd takes the checkout root, did you mean ${checkout}?`),
  };
}

/** The checkout whose `.archon/workflows` contains `path`, when the path sits inside one. */
export function checkoutRootAbove(path: string): string | undefined {
  for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
    if (basename(dir) === 'workflows' && basename(dirname(dir)) === '.archon') {
      return dirname(dirname(dir));
    }
  }
  return undefined;
}
