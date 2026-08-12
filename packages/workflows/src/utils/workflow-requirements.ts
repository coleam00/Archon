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
        'Connect GitHub (Slack: `/archon connect github`, CLI: `archon auth github`, ' +
        'or the Web UI Settings page) and re-invoke. No worktree was created and no AI cost was incurred.'
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
// Declared-input satisfiability (#2470)
// ---------------------------------------------------------------------------

/** Minimal shape needed to evaluate declared inputs — avoids a full WorkflowDefinition dep. */
export interface InputBearingWorkflow {
  name?: string;
  inputs?: Record<string, WorkflowInputSpec>;
}

/**
 * Thrown when a workflow that declares `required` inputs is invoked at the TOP LEVEL,
 * where no caller `with:` can satisfy them. `message` is user-facing and names the
 * missing inputs plus the two ways to supply them (`include:`/`workflow:` with `with:`).
 */
export class WorkflowMissingInputsError extends Error {
  constructor(
    public readonly workflowName: string | undefined,
    public readonly missing: readonly string[]
  ) {
    const names = missing.map(n => `'${n}'`).join(', ');
    super(
      `This workflow declares required input${missing.length === 1 ? '' : 's'} ${names} that only a ` +
        'caller can supply. It is a reusable block: reference it from another workflow with an ' +
        '`include:` or `workflow:` node and pass the input(s) via `with:` (e.g. `with: { ' +
        `${missing[0]}: $someNode.output }\`). No worktree was created and no AI cost was incurred.`
    );
    this.name = 'WorkflowMissingInputsError';
  }
}

/**
 * Throw {@link WorkflowMissingInputsError} when a TOP-LEVEL invocation cannot satisfy the
 * workflow's declared `required` inputs (#2470). A `required` input never carries a default
 * (the loader drops that contradiction), so a bare run can never satisfy one — the block is
 * meant to be called via `include:`/`workflow:` `with:`. The workflow still LOADS and LISTS
 * normally (discovery/builder need it visible); only top-level invocation fails, before any
 * worktree/clone/AI cost. A workflow with no declared inputs always passes.
 */
export function assertWorkflowInputsSatisfiable(workflow: InputBearingWorkflow): void {
  const inputs = workflow.inputs;
  if (!inputs) return;
  const missing = Object.entries(inputs)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .sort();
  if (missing.length > 0) {
    throw new WorkflowMissingInputsError(workflow.name, missing);
  }
}
