/**
 * The workflow a trigger binding starts, and the inputs it starts it with. A start and
 * `archon trigger check` both choose and validate them here, so a binding a start refuses
 * is the binding the check reports, for the same reason.
 */
import { basename, dirname, join, resolve } from 'node:path';
import type { JsonValue } from '@archon/workflows/output-ref';
import { resolveWorkflowName } from '@archon/workflows/router';
import { resolveInvocationInputs } from '@archon/workflows/utils/workflow-requirements';
import { WorkflowInputContractError } from '@archon/workflows/workflow-inputs';
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
 * A refusal appends a load error for the name: some copy exists but does not load. With a
 * workflow source the refusal still names the directory, wherever that copy lives.
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
  const failedToLoad = loadError && `workflow '${workflowName}' failed to load: ${loadError.error}`;
  if (discoveryCwd === undefined)
    return { refused: failedToLoad || `workflow '${workflowName}' is not in this project` };
  const root = resolve(discoveryCwd);
  const checkout = checkoutRootAbove(root);
  return {
    refused:
      `workflow '${workflowName}' is not in the binding's workflow source ${root}: Archon looked in ` +
      `${join(root, '.archon', 'workflows')}` +
      (scope ? ` and found it only in the ${scope} scope` : '') +
      (failedToLoad ? `; ${failedToLoad}` : '') +
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

function quotedList(names: readonly string[]): string {
  return names.map(name => `'${name}'`).join(', ');
}

/** The workflow requires inputs the binding does not supply. */
export class BindingMissingInputsError extends Error {
  override name = 'BindingMissingInputsError';
  constructor(
    workflowName: string,
    readonly missing: readonly string[]
  ) {
    super(
      `Workflow '${workflowName}' requires input${missing.length === 1 ? '' : 's'} ${quotedList(missing)}.`
    );
  }
}

/**
 * The binding's authored and event inputs, checked against the workflow's declared inputs
 * and its pack's settings.
 */
export function resolveBindingInputs(
  intent: Pick<ResourceStartBindingIntent, 'eventInputs'> & {
    launch: Pick<ResourceStartBindingIntent['launch'], 'inputs'>;
  },
  workflow: Pick<ResolvedWorkflow, 'name' | 'inputs' | 'pack'>
): Record<string, JsonValue> {
  // The declared-input contract passes inputs through to a workflow without `inputs:`, which
  // operator-written literals rely on. Event inputs carry untrusted source content, so
  // they reach only a workflow that declares them.
  // A pack setting is declared, by the pack, and checked against its type below.
  const settings = workflow.pack?.settings ?? {};
  const eventInputNames = Object.keys(intent.eventInputs ?? {}).filter(
    name => !Object.hasOwn(settings, name)
  );
  if (workflow.inputs === undefined && eventInputNames.length > 0) {
    throw new Error(
      `Workflow '${workflow.name}' declares no inputs; a trigger cannot pass event-mapped ` +
        `input${eventInputNames.length === 1 ? '' : 's'} ` +
        quotedList(eventInputNames.sort()) +
        ". Declare them under 'inputs:' in the workflow."
    );
  }
  try {
    // The same contract `--input` meets: the workflow's own inputs, or its pack's settings
    // checked against their declared types.
    return resolveInvocationInputs(workflow, { ...intent.launch.inputs, ...intent.eventInputs });
  } catch (error) {
    if (error instanceof WorkflowInputContractError && error.missingRequired.length > 0) {
      throw new BindingMissingInputsError(workflow.name, error.missingRequired);
    }
    throw error;
  }
}

/**
 * What a binding supplies beside `launch.inputs`: the names its `on` mapping or event
 * fills in (none for a timer, whose job runs `trigger fire --binding` alone), or
 * `'at-fire'` for a fire-only binding, whose `trigger fire --inputs` may supply any name.
 */
export type SuppliedAtStart = { mapped: readonly string[] } | 'at-fire';

/**
 * Why a start of this binding would be refused for its workflow or its inputs, by the
 * validation the start itself runs (`resolveBindingInputs`). Mapped values are known only
 * when the event happens, so they are checked by name: a placeholder stands in for each,
 * and a name that is only a pack setting is left out, with any launch literal it replaces:
 * its value, and so its type, is known only at the start.
 * For `'at-fire'` a missing required input is no problem: the fire may pass it.
 */
export function startedWorkflowInputProblems(
  started: { workflow: Pick<ResolvedWorkflow, 'name' | 'inputs' | 'pack'> } | { refused: string },
  launchInputs: Readonly<Record<string, JsonValue>> | undefined,
  supplied: SuppliedAtStart
): string[] {
  if ('refused' in started) return [started.refused];
  const { workflow } = started;
  const settings = workflow.pack?.settings ?? {};
  const mapped = supplied === 'at-fire' ? [] : supplied.mapped;
  const packOnly = (name: string): boolean =>
    Object.hasOwn(settings, name) && !Object.hasOwn(workflow.inputs ?? {}, name);
  const eventInputs = Object.fromEntries(
    mapped.filter(name => !packOnly(name)).map(name => [name, null])
  );
  // An event value replaces a launch literal of the same name at the start, so a mapped
  // pack setting's literal is never what the start checks.
  const launch = Object.fromEntries(
    Object.entries(launchInputs ?? {}).filter(
      ([name]) => !(packOnly(name) && mapped.includes(name))
    )
  );
  try {
    resolveBindingInputs({ launch: { inputs: launch }, eventInputs }, workflow);
    return [];
  } catch (error) {
    if (supplied === 'at-fire' && error instanceof BindingMissingInputsError) return [];
    return [(error as Error).message];
  }
}
