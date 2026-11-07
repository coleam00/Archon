/**
 * Workflow capability requirements gate.
 *
 * A workflow may declare `requires: [github]` in its YAML. When it does, the
 * run must be hard-blocked at invocation — before any worktree, clone, or AI
 * cost — if the originating user hasn't connected the required capability.
 *
 * This module is pure: callers resolve the runtime connection status (a DB
 * check) and pass it in. The orchestrator/CLI/web entrypoints own the I/O; this
 * just encodes the policy so all three behave identically.
 */
import type { WorkflowRequirement, WorkflowInputSpec } from '../schemas/workflow';
import type { WorkflowPack } from '../schemas/pack-settings';
import type { JsonValue } from '../output-ref';
import { packSettingValue } from '../pack-settings';
import { resolveDeclaredInputs, WorkflowInputContractError } from '../workflow-inputs';

/** Minimal shape needed to evaluate requirements — avoids a full WorkflowDefinition dep. */
export interface RequirementBearingWorkflow {
  requires?: readonly WorkflowRequirement[];
}

/** Resolved connection status for the originating user. */
export interface RequirementContext {
  /** True when the originating user has a usable GitHub connection. */
  githubConnected: boolean;
}

/**
 * Thrown when a declared requirement is unmet. `message` is user-facing and
 * actionable (it names the connect step). Callers surface `message` to the
 * platform and abort the invocation without creating a worktree or run row.
 */
export class WorkflowRequirementError extends Error {
  constructor(public readonly requirement: WorkflowRequirement) {
    super(
      `This workflow requires a connected ${requirement} identity, but you haven't connected yours. ` +
        'Connect GitHub (CLI: `archon auth github`, or the Web UI Settings page) and re-invoke. No worktree was created and no AI cost was incurred.'
    );
    this.name = 'WorkflowRequirementError';
  }
}

/**
 * Throw WorkflowRequirementError if any declared requirement is unmet. A
 * workflow with no `requires` (or an empty array) always passes.
 */
export function assertWorkflowRequirementsMet(
  workflow: RequirementBearingWorkflow,
  ctx: RequirementContext
): void {
  const requires = workflow.requires ?? [];
  if (requires.includes('github') && !ctx.githubConnected) {
    throw new WorkflowRequirementError('github');
  }
}

// ---------------------------------------------------------------------------
// Declared-input resolution for a TOP-LEVEL invocation (#2470, #2554)
// ---------------------------------------------------------------------------

/** Minimal shape needed to evaluate declared inputs — avoids a full WorkflowDefinition dep. */
export interface InputBearingWorkflow {
  name?: string;
  inputs?: Record<string, WorkflowInputSpec>;
  pack?: WorkflowPack;
}

/**
 * Thrown when a TOP-LEVEL invocation supplies no value for a workflow's `required`
 * input. `message` is user-facing and names the missing inputs plus the channels that
 * can carry them.
 *
 * Before #2554 this said the workflow "is a reusable block" that could only be called
 * from another workflow — that was the defect, not a description of the design. A
 * workflow is a workflow: it runs on its own when its inputs are supplied, and composes
 * unchanged.
 */
export class WorkflowMissingInputsError extends Error {
  constructor(
    public readonly workflowName: string | undefined,
    public readonly missing: readonly string[]
  ) {
    const names = missing.map(n => `'${n}'`).join(', ');
    const plural = missing.length === 1 ? '' : 's';
    super(
      `This workflow requires input${plural} ${names}, and none was supplied. Supply ` +
        `${missing.length === 1 ? 'it' : 'them'} with \`--input ${missing[0]}=<value>\` on the ` +
        'CLI (repeat the flag per input), or fill the run form in the web console. When ' +
        'composing this workflow from another, pass the same values via `with:` on the ' +
        '`include:`/`workflow:` node. In chat, an assistant with the `invoke_workflow` tool ' +
        'supplies them when it starts the workflow. ' +
        'No worktree was created and no AI cost was incurred.'
    );
    this.name = 'WorkflowMissingInputsError';
  }
}

/**
 * Resolve a TOP-LEVEL invocation's declared inputs from the values its channel supplied
 * (#2554) — `--input name=value` on the CLI, the `inputs` map on the run route, or the
 * console's run form.
 *
 * A supplied name may be one of the workflow's own `inputs:` or one of its pack's
 * settings, which an invocation may set for this one run. A workflow input goes through
 * {@link resolveDeclaredInputs}, the same implementation `include:` and `workflow:` use, so
 * a map accepted when composing is accepted here and vice versa; a pack setting is checked
 * against its declared type. A name that is both is the workflow's input. Callers run this
 * BEFORE any worktree, clone, run row, or AI call, matching where the `workflow:` child
 * path resolves its own `with:` map.
 *
 * Returns ONLY the caller-supplied entries. The run itself layers them over its pack's
 * settings and the declared defaults when it starts, and fixes the result on its row; a
 * `required` pack setting is checked there too, because the project's settings file may
 * supply it.
 *
 * @returns the supplied map, or undefined when nothing was supplied.
 * @throws WorkflowMissingInputsError when a `required` input has no supplied value.
 * @throws WorkflowInputContractError when a supplied key is not declared, or a pack
 *   setting's value does not fit its type.
 */
export function resolveTopLevelInputs(
  workflow: InputBearingWorkflow,
  supplied: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  const suppliedMap = { ...supplied };
  try {
    resolveInvocationInputs(workflow, suppliedMap);
  } catch (err) {
    // Re-shape only the missing-required case: its shared message ends in "Pass them
    // through 'with:'", which is the wrong remediation for a direct run.
    if (err instanceof WorkflowInputContractError && err.missingRequired.length > 0) {
      throw new WorkflowMissingInputsError(workflow.name, err.missingRequired);
    }
    throw err;
  }
  return Object.keys(suppliedMap).length > 0 ? suppliedMap : undefined;
}

/**
 * The invocation contract every run-starting channel shares (`--input`, the run route,
 * the console, a trigger binding): a supplied name is the workflow's own input, checked by
 * {@link resolveDeclaredInputs}, or one of its pack's settings, checked against the
 * setting's type. A name that is both is the workflow's input.
 *
 * @returns the supplied map, a pack setting's value as its checked text.
 * @throws WorkflowInputContractError on an undeclared name (listing the pack settings
 *   too), a mistyped pack setting, or a missing required input.
 */
export function resolveInvocationInputs(
  workflow: InputBearingWorkflow,
  supplied: Readonly<Record<string, JsonValue>>
): Record<string, JsonValue> {
  const context = `Cannot run workflow '${workflow.name ?? 'unknown'}'`;
  const settings = workflow.pack?.settings ?? {};
  const resolved: Record<string, JsonValue> = {};
  const forWorkflow: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(supplied)) {
    const spec =
      Object.hasOwn(settings, name) && !Object.hasOwn(workflow.inputs ?? {}, name)
        ? settings[name]
        : undefined;
    if (spec === undefined) {
      forWorkflow[name] = value;
      resolved[name] = value;
      continue;
    }
    const checked = packSettingValue(spec, value);
    if ('error' in checked) {
      throw new WorkflowInputContractError(`${context}: pack setting '${name}' ${checked.error}.`);
    }
    resolved[name] = checked.value;
  }
  try {
    resolveDeclaredInputs(forWorkflow, workflow.inputs, context, 'it');
  } catch (err) {
    throw withPackSettingNames(err, Object.keys(settings));
  }
  return resolved;
}

/** An undeclared name is told the pack settings it could also have meant. */
function withPackSettingNames(err: unknown, settingNames: readonly string[]): unknown {
  if (!(err instanceof WorkflowInputContractError)) return err;
  if (err.undeclared.length === 0 || settingNames.length === 0) return err;
  return new WorkflowInputContractError(
    `${err.message} Pack settings: ${[...settingNames].sort().join(', ')}.`,
    { undeclared: err.undeclared }
  );
}
