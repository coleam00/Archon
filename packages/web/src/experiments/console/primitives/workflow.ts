export type WorkflowSource = 'project' | 'global' | 'bundled';

export interface Workflow {
  name: string;
  description: string | null;
  source: WorkflowSource;
}

interface RawWorkflowEntry {
  workflow: {
    name: string;
    description?: string | null;
  };
  source: string;
}

export function toWorkflow(raw: RawWorkflowEntry): Workflow {
  const src = raw.source === 'project' ? 'project' : 'bundled';
  return {
    name: raw.workflow.name,
    description: raw.workflow.description ?? null,
    source: src,
  };
}
