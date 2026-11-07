import type { components } from '@/lib/api.generated';
import type { QueryParams } from '../lib/api-types';
import type {
  WorkflowListResult,
  LoadedWorkflow,
  InstalledPackWorkflow,
  WorkflowLoad,
} from '../primitives/workflow';
export type {
  WorkflowListResult,
  LoadedWorkflow,
  InstalledPackWorkflow,
  WorkflowLoad,
} from '../primitives/workflow';
import { requestJson } from '../lib/http';
import { toWorkflow, type WorkflowSource } from '../primitives/workflow';
import type { WorkflowGraphNode } from '../primitives/workflow-graph';
import type { BuilderWorkflowDefinition } from '../builder/types';
import type { WireWorkflowDefinition } from '../builder/types/wire';

type RawNode = components['schemas']['DagNode'];

export async function listWorkflows(cwd?: string): Promise<WorkflowListResult> {
  const res = await requestJson('/api/workflows', 'get', { query: { cwd } });
  return { workflows: res.workflows.map(toWorkflow), recommended: res.recommended ?? [] };
}

function nodeKind(n: RawNode): WorkflowGraphNode['kind'] {
  if (n.loop !== undefined) return 'loop';
  if (n.approval !== undefined) return 'approval';
  if (n.wait !== undefined) return 'wait';
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
  const res = await requestJson('/api/workflows', 'get', { query: { cwd } });
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

/**
 * Where a loaded workflow lives. Read-only for `bundled` and `installed` (see `isReadOnlySource`).
 * Re-exported from `primitives/workflow` (single source of truth) so the union
 * cannot silently diverge between the list primitive and the CRUD verbs.
 */
export type { WorkflowSource };

export function isInstalledPackWorkflow(load: WorkflowLoad): load is InstalledPackWorkflow {
  return 'installedPack' in load;
}

export type WorkflowSaveSource = NonNullable<QueryParams<'/api/workflows/{name}', 'put'>['source']>;
export type GetWorkflowResponse = components['schemas']['GetWorkflowResponse'];
export type ValidateWorkflowResponse = components['schemas']['ValidateWorkflowResponse'];

/**
 * Load a single workflow definition by name for the selected project.
 *
 * GOTCHA: the single-name `GET /api/workflows/:name` does NOT recurse into
 * `.archon/workflows/<subdir>/` (matches `getWorkflowGraph`'s note). Workflows
 * in subfolders won't load here — callers surface a "not found" empty state.
 */
export async function loadWorkflow(name: string, cwd: string): Promise<WorkflowLoad> {
  const res = await requestJson('/api/workflows/{name}', 'get', {
    params: { name },
    query: { cwd },
  });
  if (res.authored === undefined) {
    if (res.source === 'installed') return { installedPack: true, name };
    // Editing the normalized form would open every node as unrecognised and
    // write them back as empty prompts — refuse rather than corrupt on save.
    throw new Error(`GET /api/workflows/${name} returned no authored form; cannot edit it`);
  }
  // The server parsed this same mapping with parseWorkflow before answering.
  const definition = res.authored as unknown as WireWorkflowDefinition;
  return { definition, filename: res.filename, source: res.source };
}

/** Persist (create or update) a workflow YAML via PUT `?cwd=&source=`. */
export async function saveWorkflow(
  name: string,
  definition: WireWorkflowDefinition,
  opts: { cwd: string; source: WorkflowSaveSource }
): Promise<LoadedWorkflow> {
  const res = await requestJson('/api/workflows/{name}', 'put', {
    params: { name },
    query: opts,
    body: { definition },
  });
  // The file now holds exactly `definition` (the PUT response carries only the
  // normalized form), so that is the authored definition to report back.
  return { definition, filename: res.filename, source: res.source };
}

/** Delete a user-defined workflow via DELETE `?cwd=&source=`. Bundled deletes 400 server-side. */
export async function deleteWorkflow(
  name: string,
  opts: { cwd: string; source: WorkflowSaveSource }
): Promise<void> {
  await requestJson('/api/workflows/{name}', 'delete', { params: { name }, query: opts });
}

/**
 * Server-tier validation. Returns HTTP 200 even when invalid, so `requestJson`
 * will NOT throw — branch on `valid` and map `errors[]` into the issue panel.
 * NO `?cwd=` (validation is stateless).
 */
export function validateWorkflow(
  definition: BuilderWorkflowDefinition
): Promise<ValidateWorkflowResponse> {
  return requestJson('/api/workflows/validate', 'post', { body: { definition } });
}
