export type WorkflowSource = 'project' | 'global' | 'bundled';

/**
 * One entry of a workflow's declared `inputs:` signature (#2470), flattened for
 * rendering. A run supplies values for these; an omitted name takes `default`, and a
 * `required` one with no value is refused before the run starts (#2554).
 */
export interface WorkflowInput {
  name: string;
  required: boolean;
  default: string | null;
  description: string | null;
}

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
  /** Declared `inputs:` in declaration order; empty when the workflow declares none. */
  inputs: WorkflowInput[];
}

/**
 * The workflow object as `GET /api/workflows` sends it, for the fields the console
 * reads. Exported because `skills/workflows.ts` describes the same wire shape for its
 * own `listWorkflows`/`getWorkflowGraph` calls — two hand-rolled copies drifted once
 * already (its copy never learned about `inputs`, which type-checked silently because
 * a missing optional property still satisfies the parameter type, and would have gone
 * on compiling while the run form quietly stopped rendering).
 */
export interface RawWorkflowShape {
  name: string;
  description?: string | null;
  inputs?: Record<
    string,
    { required?: boolean; default?: string; description?: string } | null | undefined
  >;
  returns?: string;
}

interface RawWorkflowEntry {
  workflow: RawWorkflowShape;
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
  // Object key order preserves the YAML's declaration order for string keys, so the
  // run form renders inputs in the order the author wrote them.
  const inputs: WorkflowInput[] = Object.entries(raw.workflow.inputs ?? {}).map(([name, spec]) => ({
    name,
    required: spec?.required === true,
    default: spec?.default ?? null,
    description: spec?.description ?? null,
  }));
  return {
    name: raw.workflow.name,
    description: raw.workflow.description ?? null,
    source: src,
    parseWarnings: raw.parseWarnings ?? [],
    inputs,
  };
}
