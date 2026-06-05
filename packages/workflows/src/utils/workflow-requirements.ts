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
import type { WorkflowRequirement } from '../schemas/workflow';

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
