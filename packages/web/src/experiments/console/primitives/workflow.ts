export type WorkflowSource = 'project' | 'global' | 'bundled';

export interface Workflow {
  name: string;
  description: string | null;
  source: WorkflowSource;
  /**
   * Keys this workflow's YAML declares that the engine silently drops (#2213).
   * Empty for a clean workflow. The workflow still loads and runs — this is what
   * was ignored, which can include a gate the author believed they had.
   */
  parseWarnings: string[];
}

interface RawWorkflowEntry {
  workflow: {
    name: string;
    description?: string | null;
  };
  source: string;
  parseWarnings?: string[];
}

export function toWorkflow(raw: RawWorkflowEntry): Workflow {
  // Three distinct sources matter for sort + badge: project (repo-local)
  // > global (home-scoped `~/.archon/workflows`) > bundled (defaults
  // shipped with Archon). Collapsing `global` into `bundled` silently
  // demoted home-scoped workflows and rendered them with the wrong badge.
  const src: WorkflowSource =
    raw.source === 'project' ? 'project' : raw.source === 'global' ? 'global' : 'bundled';
  return {
    name: raw.workflow.name,
    description: raw.workflow.description ?? null,
    source: src,
    parseWarnings: raw.parseWarnings ?? [],
  };
}
