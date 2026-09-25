import type { WorkflowCommandSurface } from '@archon/workflows/deps';

/**
 * How an operator types a workflow command in this CLI. The platform adapter and every
 * other CLI renderer share this one spelling rather than each restating it.
 */
export const CLI_WORKFLOW_SURFACE: Required<WorkflowCommandSurface> = {
  formatWorkflowCommand: command => `archon workflow ${command}`,
};
