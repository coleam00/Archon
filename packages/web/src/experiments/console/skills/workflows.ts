import { requestJson } from '../lib/http';
import { toWorkflow, type Workflow } from '../primitives/workflow';
import type { WorkflowGraphNode } from '../primitives/workflow-graph';

interface WorkflowsResponse {
  workflows: Parameters<typeof toWorkflow>[0][];
  errors?: unknown[];
}

export async function listWorkflows(cwd?: string): Promise<Workflow[]> {
  const qs = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await requestJson<WorkflowsResponse>(`/api/workflows${qs}`);
  return res.workflows.map(toWorkflow);
}

interface GetWorkflowResponse {
  workflow: {
    name: string;
    nodes: RawNode[];
  };
  filename: string;
  source: string;
}

interface RawNode {
  id: string;
  depends_on?: string[];
  prompt?: string;
  bash?: string;
  command?: string;
  approval?: unknown;
  loop?: unknown;
  script?: unknown;
}

/**
 * Get a workflow's DAG structure (nodes + dependencies) for the graph panel.
 * The server returns the full YAML definition; we narrow to the shape the
 * console needs.
 */
export async function getWorkflowGraph(name: string, cwd?: string): Promise<WorkflowGraphNode[]> {
  const qs = cwd !== undefined ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await requestJson<GetWorkflowResponse>(
    `/api/workflows/${encodeURIComponent(name)}${qs}`
  );
  return res.workflow.nodes.map(
    (n): WorkflowGraphNode => ({
      id: n.id,
      dependsOn: n.depends_on ?? [],
      kind:
        n.loop !== undefined
          ? 'loop'
          : n.approval !== undefined
            ? 'approval'
            : n.bash !== undefined
              ? 'bash'
              : n.command !== undefined
                ? 'command'
                : n.script !== undefined
                  ? 'script'
                  : 'prompt',
    })
  );
}
