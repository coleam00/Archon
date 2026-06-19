import { requestJson } from '../lib/http';
import { toWorkflow, type Workflow } from '../primitives/workflow';
import type { WorkflowGraphNode } from '../primitives/workflow-graph';
import type { WireWorkflowDefinition } from '../builder/types/wire';

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

// ---------------------------------------------------------------------------
// PR-3 connected-mode CRUD verbs. The single-name endpoints below are the live
// seam the builder's BuilderConnected route saves through. URL/body shaping is
// extracted into pure builders so it can be unit-tested without `fetch`.
// ---------------------------------------------------------------------------

/** Where a loaded workflow lives. Read-only iff `source === 'bundled'`. */
export type WorkflowSource = 'project' | 'global' | 'bundled';

/** Save target — bundled opens read-only, so Save-as always writes a project override. */
export type WorkflowSaveSource = 'project' | 'global';

/** `GET /api/workflows/:name` response (observed live — see plan Spike #2). */
export interface GetWorkflowResponse {
  workflow: WireWorkflowDefinition;
  filename: string;
  source: WorkflowSource;
}

/** Normalized result of `loadWorkflow`. */
export interface LoadedWorkflow {
  definition: WireWorkflowDefinition;
  filename: string;
  source: WorkflowSource;
}

/** `POST /api/workflows/validate` response — HTTP 200 even when `valid` is false. */
export interface ValidateWorkflowResponse {
  valid: boolean;
  errors?: string[];
}

/** Build the single-name GET/PUT/DELETE path with an encoded `?cwd=` query. */
export function buildWorkflowPath(name: string, cwd: string): string {
  return `/api/workflows/${encodeURIComponent(name)}?cwd=${encodeURIComponent(cwd)}`;
}

/** Build the PUT/DELETE path, appending `&source=` to the cwd query. */
export function buildSavePath(name: string, cwd: string, source: WorkflowSaveSource): string {
  return `${buildWorkflowPath(name, cwd)}&source=${source}`;
}

/**
 * Load a single workflow definition by name for the selected project.
 *
 * GOTCHA: the single-name `GET /api/workflows/:name` does NOT recurse into
 * `.archon/workflows/<subdir>/` (matches `getWorkflowGraph`'s note). Workflows
 * in subfolders won't load here — callers surface a "not found" empty state.
 */
export async function loadWorkflow(name: string, cwd: string): Promise<LoadedWorkflow> {
  const res = await requestJson<GetWorkflowResponse>(buildWorkflowPath(name, cwd));
  return { definition: res.workflow, filename: res.filename, source: res.source };
}

/** Persist (create or update) a workflow YAML via PUT `?cwd=&source=`. */
export async function saveWorkflow(
  name: string,
  definition: WireWorkflowDefinition,
  opts: { cwd: string; source: WorkflowSaveSource }
): Promise<LoadedWorkflow> {
  const res = await requestJson<GetWorkflowResponse>(buildSavePath(name, opts.cwd, opts.source), {
    method: 'PUT',
    body: JSON.stringify({ definition }),
  });
  return { definition: res.workflow, filename: res.filename, source: res.source };
}

/** Delete a user-defined workflow via DELETE `?cwd=&source=`. Bundled deletes 400 server-side. */
export async function deleteWorkflow(
  name: string,
  opts: { cwd: string; source: WorkflowSaveSource }
): Promise<void> {
  await requestJson(buildSavePath(name, opts.cwd, opts.source), { method: 'DELETE' });
}

/**
 * Server-tier validation. Spike #2: returns HTTP 200 even when invalid, so
 * `requestJson` will NOT throw — branch on `valid` and map `errors[]` into the
 * issue panel. NO `?cwd=` (validation is stateless).
 */
export function validateWorkflow(
  definition: WireWorkflowDefinition
): Promise<ValidateWorkflowResponse> {
  return requestJson<ValidateWorkflowResponse>('/api/workflows/validate', {
    method: 'POST',
    body: JSON.stringify({ definition }),
  });
}
