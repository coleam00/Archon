import { requestJson } from '../lib/http';
import { toWorkflow, type Workflow } from '../primitives/workflow';
import type { WorkflowGraphNode } from '../primitives/workflow-graph';

interface RawNode {
  id: string;
  depends_on?: string[];
  prompt?: string;
  bash?: string;
  command?: string;
  cancel?: string;
  approval?: unknown;
  loop?: unknown;
  script?: unknown;
}

interface RawWorkflow {
  name: string;
  description?: string;
  nodes?: RawNode[];
}

interface WorkflowListEntry {
  workflow: RawWorkflow;
  filename?: string;
  source: string;
}

interface WorkflowsResponse {
  workflows: WorkflowListEntry[];
  /** Repo-curated workflow names to pin on top, in declared order (PR #1929). */
  recommended?: string[];
  errors?: unknown[];
}

/** Discovered workflows plus the repo-curated recommended names (declared order). */
export interface WorkflowListResult {
  workflows: Workflow[];
  recommended: string[];
}

export async function listWorkflows(cwd?: string): Promise<WorkflowListResult> {
  const qs = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await requestJson<WorkflowsResponse>(`/api/workflows${qs}`);
  return { workflows: res.workflows.map(toWorkflow), recommended: res.recommended ?? [] };
}

function nodeKind(n: RawNode): WorkflowGraphNode['kind'] {
  if (n.loop !== undefined) return 'loop';
  if (n.approval !== undefined) return 'approval';
  if (n.cancel !== undefined) return 'cancel';
  if (n.bash !== undefined) return 'bash';
  if (n.command !== undefined) return 'command';
  if (n.script !== undefined) return 'script';
  return 'prompt';
}

/**
 * Get a workflow's DAG structure (nodes + dependencies) for the graph panel.
 *
 * We route through the list endpoint and filter by name rather than calling
 * `/api/workflows/:name` directly because the single-fetch route doesn't
 * recurse into `.archon/workflows/<subdir>/` while the list route does. Both
 * carry the full DAG, so this trades one extra row of JSON for correctness
 * across subfoldered workflows.
 */
export async function getWorkflowGraph(name: string, cwd?: string): Promise<WorkflowGraphNode[]> {
  const qs = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await requestJson<WorkflowsResponse>(`/api/workflows${qs}`);
  const match = res.workflows.find(w => w.workflow.name === name);
  if (match === undefined) {
    throw new Error(`Workflow not found: ${name}`);
  }
  const nodes = match.workflow.nodes ?? [];
  return nodes.map(
    (n): WorkflowGraphNode => ({
      id: n.id,
      dependsOn: n.depends_on ?? [],
      kind: nodeKind(n),
    })
  );
}
