import type { WorkflowDefinition } from './schemas';
import { levenshtein } from './utils/fuzzy-match';

export function findWorkflow<T extends Pick<WorkflowDefinition, 'name'>>(
  name: string,
  workflows: readonly T[]
): T | undefined {
  return workflows.find(w => w.name === name);
}

export { findWorkflow as resolveWorkflowName };

/** Human-facing hints only; suggestions never select a workflow. */
export function suggestWorkflowNames(
  name: string,
  workflows: readonly Pick<WorkflowDefinition, 'name'>[]
): string[] {
  const requested = name.toLowerCase();
  return workflows
    .map(workflow => ({
      name: workflow.name,
      distance: workflow.name.toLowerCase().includes(requested)
        ? 0
        : levenshtein(requested, workflow.name.toLowerCase()),
    }))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(candidate => candidate.name);
}
