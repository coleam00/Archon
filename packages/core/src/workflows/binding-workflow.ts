/**
 * The workflow a trigger binding starts. A fire and `archon trigger check` both choose it
 * here, so a binding the fire refuses is the binding the check reports, for the same reason.
 */
import { basename, dirname, join, resolve } from 'node:path';
import { resolveWorkflowName } from '@archon/workflows/router';
import type { ResolvedWorkflow, WorkflowWithSource } from '@archon/workflows/schemas/workflow';
import type { ResourceStartBindingIntent } from '@archon/workflows/schemas/resource-start';

export type StartedWorkflow = { workflow: ResolvedWorkflow } | { refused: string };

/**
 * Without `discoveryCwd` the name resolves across every scope. With it, the workflow must
 * come from `<discoveryCwd>/.archon/workflows`: another scope's copy of the same name would
 * run while the run records the directory as its source (#5853). Commands, scripts and
 * composed workflows may still resolve from other scopes; the started workflow may not.
 */
export function selectStartedWorkflow(
  launch: Pick<ResourceStartBindingIntent['launch'], 'workflowName' | 'discoveryCwd'>,
  discovered: readonly WorkflowWithSource[]
): StartedWorkflow {
  const { workflowName, discoveryCwd } = launch;
  const workflow = resolveWorkflowName(
    workflowName,
    discovered.map(entry => entry.workflow)
  );
  if (discoveryCwd === undefined)
    return workflow
      ? { workflow }
      : { refused: `workflow '${workflowName}' is not in this project` };
  const scope = discovered.find(entry => entry.workflow === workflow)?.source;
  if (workflow && scope === 'project') return { workflow };
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
