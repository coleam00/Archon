import type { WorkflowRun } from './workflow-run';

export function hasUnknownTokenTotal(metadata: WorkflowRun['metadata']): boolean {
  return Object.hasOwn(metadata, 'total_tokens_unknown') && metadata.total_tokens_unknown !== false;
}
