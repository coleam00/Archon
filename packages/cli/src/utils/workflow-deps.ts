import {
  createWorkflowDeps,
  initializeWorkflowGitHubAppAuth,
} from '@archon/core/workflows/store-adapter';

export function createCliWorkflowDeps(): ReturnType<typeof createWorkflowDeps> {
  initializeWorkflowGitHubAppAuth();
  return createWorkflowDeps();
}
