import type { WorkflowRun } from './workflow-run';

export const TOTAL_COST_INCOMPLETE = 'total_cost_incomplete';

export function hasIncompleteCostTotal(metadata: WorkflowRun['metadata']): boolean {
  return metadata[TOTAL_COST_INCOMPLETE] === true;
}

export function hasUnknownTokenTotal(metadata: WorkflowRun['metadata']): boolean {
  return Object.hasOwn(metadata, 'total_tokens_unknown') && metadata.total_tokens_unknown !== false;
}
