import type { WorkflowDefinition } from '../schemas';

export interface CodebaseInfo {
  id: string;
  name: string;
  default_cwd: string;
}

export interface WorkflowListItem {
  workflow: WorkflowDefinition;
  source: 'project' | 'global' | 'bundled';
}

export interface ValidateResult {
  valid: boolean;
  errors?: string[];
}

/**
 * The seam. studio-core takes no opinion on HTTP. Implementations live elsewhere:
 *   - studio-api-archon (default REST client)
 *   - host adapter (when embedded in Archon, wraps Archon's internal apiClient)
 */
export interface WorkflowApiClient {
  // discovery
  listCodebases(): Promise<CodebaseInfo[] | null>; // null = endpoint not exposed by this Archon
  listWorkflows(cwd: string): Promise<WorkflowListItem[]>;
  listCommands(cwd: string): Promise<{ name: string; source: 'project' | 'global' | 'bundled' }[]>;
  listProviders(): Promise<{ id: string; capabilities: Record<string, boolean> }[]>;

  // CRUD
  getWorkflow(name: string, cwd: string): Promise<WorkflowDefinition>;
  saveWorkflow(
    name: string,
    cwd: string,
    definition: WorkflowDefinition
  ): Promise<WorkflowDefinition>;
  deleteWorkflow(name: string, cwd: string): Promise<void>;

  // validation
  validateWorkflow(definition: WorkflowDefinition): Promise<ValidateResult>;

  // server health (used by the connect screen)
  ping(): Promise<{ ok: true; serverVersion?: string }>;
}
