import {
  createWorkflowDeps,
  initializeWorkflowGitHubAppAuth,
} from '@archon/core/workflows/store-adapter';
import type { WorkflowDeps } from '@archon/workflows/deps';

export function createCliWorkflowDeps(): WorkflowDeps {
  initializeWorkflowGitHubAppAuth();
  return createWorkflowDeps();
}
