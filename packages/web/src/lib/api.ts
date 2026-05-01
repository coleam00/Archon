/**
 * API client functions for the Archon Web UI.
 * Uses relative URLs - Vite proxy handles routing in dev.
 * SSE streams bypass the proxy in dev mode (Vite proxy buffers SSE responses).
 */
import type { WorkflowRunStatus } from '@/lib/types';
import type { components } from '@/lib/api.generated';

export type WorkflowDefinition = components['schemas']['WorkflowDefinition'];
export type DagNode = components['schemas']['DagNode'];

/**
 * Base URL for SSE streams. In dev, bypasses Vite proxy by connecting directly
 * to the backend server. In production, uses relative URLs (same origin).
 * Uses the page hostname so it works from any network interface.
 */
const apiPort = (import.meta.env.VITE_API_PORT as string | undefined) ?? '3090';
export const SSE_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:${apiPort}`
  : '';

export { getCodebaseInput } from '@/lib/codebase-input';

export interface ConversationResponse {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  ai_assistant_type: string;
  title: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodebaseResponse {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
  commands: Record<string, { path: string; description: string }>;
  created_at: string;
  updated_at: string;
}

export interface HealthResponse {
  status: string;
  adapter: string;
  concurrency: {
    active: number;
    queuedTotal: number;
    maxConcurrent: number;
  };
  runningWorkflows: number;
  version?: string;
  is_docker: boolean;
  activePlatforms?: string[];
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const path = new URL(url, window.location.origin).pathname;
    const error = new Error(`API error ${String(res.status)} (${path}): ${truncated}`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

// Providers
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  builtIn: boolean;
}

export type ProviderDefaults = Record<string, unknown>;

export interface SafeConfigResponse {
  botName: string;
  assistant: string;
  assistants: Record<string, ProviderDefaults>;
  streaming: {
    telegram: 'stream' | 'batch';
    discord: 'stream' | 'batch';
    slack: 'stream' | 'batch';
  };
  concurrency: {
    maxConversations: number;
  };
  defaults: {
    copyDefaults: boolean;
    loadDefaultCommands: boolean;
    loadDefaultWorkflows: boolean;
  };
}

export interface UpdateAssistantConfigBody {
  assistant?: string;
  assistants?: Record<string, ProviderDefaults>;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const data = await fetchJSON<{ providers: ProviderInfo[] }>('/api/providers');
  return data.providers;
}

// Conversations
export async function listConversations(codebaseId?: string): Promise<ConversationResponse[]> {
  const params = new URLSearchParams();
  if (codebaseId) params.set('codebaseId', codebaseId);
  const qs = params.toString();
  return fetchJSON<ConversationResponse[]>(`/api/conversations${qs ? `?${qs}` : ''}`);
}

export async function createConversation(
  codebaseId?: string,
  message?: string
): Promise<{ conversationId: string; id: string; dispatched?: boolean }> {
  const body: Record<string, string> = {};
  if (codebaseId) body.codebaseId = codebaseId;
  if (message) body.message = message;

  return fetchJSON('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function updateConversation(
  id: string,
  updates: { title?: string }
): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function deleteConversation(id: string): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function sendMessage(
  conversationId: string,
  message: string,
  files?: File[]
): Promise<{ accepted: boolean; status: string }> {
  const url = `/api/conversations/${encodeURIComponent(conversationId)}/message`;

  if (!files || files.length === 0) {
    return fetchJSON(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }

  const form = new FormData();
  form.append('message', message);
  for (const file of files) {
    form.append('files', file, file.name);
  }
  // No Content-Type header — browser sets multipart/form-data with boundary automatically
  return fetchJSON(url, { method: 'POST', body: form });
}

// Messages
export interface MessageResponse {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: string;
  created_at: string;
}

export async function getMessages(conversationId: string, limit = 200): Promise<MessageResponse[]> {
  return fetchJSON<MessageResponse[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${String(limit)}`
  );
}

// Codebases
export async function listCodebases(): Promise<CodebaseResponse[]> {
  return fetchJSON<CodebaseResponse[]>('/api/codebases');
}

export async function getCodebase(id: string): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>(`/api/codebases/${id}`);
}

export async function addCodebase(
  input: { url: string } | { path: string }
): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteCodebase(id: string): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(`/api/codebases/${id}`, { method: 'DELETE' });
}

export interface WorkflowRunResponse {
  id: string;
  workflow_name: string;
  conversation_id: string;
  parent_conversation_id: string | null;
  codebase_id: string | null;
  status: WorkflowRunStatus;
  user_message: string;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string | null;
  worker_platform_id?: string;
  parent_platform_id?: string;
  conversation_platform_id?: string;
}

export interface WorkflowEventResponse {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export type WorkflowListEntry = components['schemas']['WorkflowListEntry'];

export async function listWorkflows(cwd?: string): Promise<WorkflowListEntry[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const result = await fetchJSON<{ workflows: WorkflowListEntry[] }>(`/api/workflows${params}`);
  return result.workflows;
}

export async function runWorkflow(
  name: string,
  conversationId: string,
  message: string
): Promise<{ accepted: boolean; status: string }> {
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message }),
  });
}

// Dashboard-enriched workflow run (includes joined data from single SQL query)
export interface DashboardRunResponse extends Omit<
  WorkflowRunResponse,
  'worker_platform_id' | 'parent_platform_id'
> {
  working_path: string | null;
  codebase_name: string | null;
  platform_type: string | null;
  worker_platform_id: string | null;
  parent_platform_id: string | null;
  current_step_name: string | null;
  total_steps: number | null;
  current_step_status: 'running' | 'completed' | 'failed' | null;
  agents_completed: number | null;
  agents_failed: number | null;
  agents_total: number | null;
}

/** Status counts across all matching runs (ignoring status filter). */
export interface DashboardCounts {
  all: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  pending: number;
  paused: number;
}

/** Paginated dashboard runs response. */
export interface DashboardRunsResult {
  runs: DashboardRunResponse[];
  total: number;
  counts: DashboardCounts;
  /** Cursor for the next page, or null when no more rows match. */
  nextCursor: string | null;
}

export async function listDashboardRuns(options?: {
  status?: WorkflowRunStatus;
  codebaseId?: string;
  search?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  errorClass?: string;
  cursor?: string;
}): Promise<DashboardRunsResult> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.codebaseId) params.set('codebaseId', options.codebaseId);
  if (options?.search) params.set('search', options.search);
  if (options?.after) params.set('after', options.after);
  if (options?.before) params.set('before', options.before);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.errorClass) params.set('errorClass', options.errorClass);
  if (options?.cursor) params.set('cursor', options.cursor);
  const qs = params.toString();
  return fetchJSON<DashboardRunsResult>(`/api/dashboard/runs${qs ? `?${qs}` : ''}`);
}

export interface ReplayDriftResponse {
  yaml_changed: boolean;
  repo_head_changed: boolean;
  current_yaml_hash: string;
  original_yaml_hash: string | null;
  current_repo_head: string | null;
  original_repo_head: string | null;
}

export interface ReplayPreviewResponse {
  mode: 'preview';
  preview: {
    original_run_id: string;
    workflow_name: string;
    drift: ReplayDriftResponse;
  };
}

export interface ReplayLaunchResponse {
  mode: 'launched';
  result: {
    new_run_id: string;
    new_conversation_id: string;
    workflow_name: string;
    drift: ReplayDriftResponse;
  };
}

export async function previewReplay(runId: string): Promise<ReplayPreviewResponse> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function launchReplayApi(runId: string): Promise<ReplayLaunchResponse> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
}

export async function cancelWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export async function resumeWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
  });
}

export async function abandonWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/abandon`, {
    method: 'POST',
  });
}

export async function deleteWorkflowRun(
  runId: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
}

export async function approveWorkflowRun(
  runId: string,
  comment?: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
}

export async function rejectWorkflowRun(
  runId: string,
  reason?: string
): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: WorkflowRunStatus;
  limit?: number;
  codebaseId?: string;
}): Promise<WorkflowRunResponse[]> {
  const params = new URLSearchParams();
  if (options?.conversationId) params.set('conversationId', options.conversationId);
  if (options?.status) params.set('status', options.status);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.codebaseId) params.set('codebaseId', options.codebaseId);
  const qs = params.toString();
  const result = await fetchJSON<{ runs: WorkflowRunResponse[] }>(
    `/api/workflows/runs${qs ? `?${qs}` : ''}`
  );
  return result.runs;
}

export async function getWorkflowRun(
  runId: string
): Promise<{ run: WorkflowRunResponse; events: WorkflowEventResponse[] }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export async function getWorkflowRunByWorker(
  workerPlatformId: string
): Promise<{ run: WorkflowRunResponse } | null> {
  try {
    return await fetchJSON(`/api/workflows/runs/by-worker/${encodeURIComponent(workerPlatformId)}`);
  } catch (e: unknown) {
    // 404 means no run exists yet — expected during dispatch
    if ((e as Error & { status?: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export type WorkflowSource = components['schemas']['WorkflowSource'];

export interface GetWorkflowResponse {
  workflow: WorkflowDefinition;
  filename: string;
  source: WorkflowSource;
}

export async function getWorkflow(name: string, cwd?: string): Promise<GetWorkflowResponse> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`);
}

export async function saveWorkflow(
  name: string,
  definition: WorkflowDefinition,
  cwd?: string
): Promise<GetWorkflowResponse> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition }),
  });
}

export async function deleteWorkflow(
  name: string,
  cwd?: string
): Promise<{ deleted: boolean; name: string }> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}${params}`, {
    method: 'DELETE',
  });
}

export async function validateWorkflow(
  definition: WorkflowDefinition
): Promise<{ valid: boolean; errors?: string[] }> {
  return fetchJSON('/api/workflows/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition }),
  });
}

export interface TestRunResponse {
  tempName: string;
  conversationId: string;
  accepted: boolean;
  status: string;
}

export async function testRunWorkflow(
  definition: WorkflowDefinition,
  options: { codebaseId?: string; cwd?: string; message?: string } = {}
): Promise<TestRunResponse> {
  return fetchJSON('/api/workflows/test-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition, ...options }),
  });
}

export interface CommandEntry {
  name: string;
  source: WorkflowSource;
}

export async function listCommands(cwd?: string): Promise<CommandEntry[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const result = await fetchJSON<{ commands: CommandEntry[] }>(`/api/commands${params}`);
  return result.commands;
}

export async function getConfig(): Promise<{ config: SafeConfigResponse; database: string }> {
  return fetchJSON('/api/config');
}

export async function updateAssistantConfig(
  body: UpdateAssistantConfigBody
): Promise<{ config: SafeConfigResponse; database: string }> {
  return fetchJSON('/api/config/assistants', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type IsolationEnvironment = components['schemas']['IsolationEnvironment'];

export async function getCodebaseEnvironments(codebaseId: string): Promise<IsolationEnvironment[]> {
  const result = await fetchJSON<{ environments: IsolationEnvironment[] }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/environments`
  );
  return result.environments;
}

// Codebase env vars
export async function getCodebaseEnvVars(codebaseId: string): Promise<string[]> {
  const result = await fetchJSON<{ keys: string[] }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/env`
  );
  return result.keys;
}

export async function setCodebaseEnvVar(
  codebaseId: string,
  data: { key: string; value: string }
): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(`/api/codebases/${encodeURIComponent(codebaseId)}/env`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function deleteCodebaseEnvVar(
  codebaseId: string,
  key: string
): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(
    `/api/codebases/${encodeURIComponent(codebaseId)}/env/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
}

// Artifacts (Mission Control gallery)
export interface ArtifactFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

export async function listArtifacts(runId: string): Promise<ArtifactFile[]> {
  const result = await fetchJSON<{ files: ArtifactFile[] }>(
    `/api/artifacts/${encodeURIComponent(runId)}`
  );
  return result.files;
}

/** Direct URL to a specific artifact file — for <img>, <video>, <a download>. */
export function artifactUrl(runId: string, path: string): string {
  // Encode each path segment but keep the slashes (the server does its own decode).
  const encoded = path
    .split('/')
    .map(s => encodeURIComponent(s))
    .join('/');
  return `/api/artifacts/${encodeURIComponent(runId)}/${encoded}`;
}

// Linear (Mission Control bidi sync)
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number | null;
  url: string | null;
  state: { id: string; name: string; type: string } | null;
  updatedAt: string | null;
}

export async function listLinearIssues(): Promise<LinearIssue[]> {
  const result = await fetchJSON<{ issues: LinearIssue[] }>('/api/linear/issues');
  return result.issues;
}

export async function updateLinearIssue(
  id: string,
  body: { stateId?: string; sortOrder?: number }
): Promise<{ ok: boolean }> {
  return fetchJSON(`/api/linear/issues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// System
export async function getHealth(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>('/api/health');
}

export type UpdateCheckResult = components['schemas']['UpdateCheckResponse'];

export async function getUpdateCheck(): Promise<UpdateCheckResult> {
  return fetchJSON<UpdateCheckResult>('/api/update-check');
}

// =========================================================================
// Compass — visual canvas for "what feature to build next"
// =========================================================================

export type CompassRealFeatureNode = components['schemas']['RealFeatureNode'];
export type CompassRealFeatureEdge = components['schemas']['RealFeatureEdge'];
export type CompassGhostFeatureNode = components['schemas']['CompassGhostFeatureNode'];
export type CompassAnnotation = components['schemas']['CompassAnnotation'];
export type CompassNorthStar = components['schemas']['CompassNorthStar'];
export type CompassObjective = components['schemas']['CompassObjective'];
export type CompassGraphResponse = components['schemas']['CompassGraphResponse'];
export type CompassPosition = components['schemas']['CompassPosition'];
export type CompassPromoteTarget = components['schemas']['CompassPromoteTarget'];
export type CompassPromoteResponse = components['schemas']['CompassPromoteGhostResponse'];
export type CompassUpsertResponse = components['schemas']['CompassUpsertGhostResponse'];
export type CompassAnnotateResponse = components['schemas']['CompassAnnotateGhostResponse'];

export async function fetchCompassGraph(codebaseId: string): Promise<CompassGraphResponse> {
  return fetchJSON<CompassGraphResponse>(`/api/compass/${encodeURIComponent(codebaseId)}/graph`);
}

export async function upsertCompassGhost(
  codebaseId: string,
  body: { id?: string; title: string; notes?: string; position: CompassPosition }
): Promise<CompassUpsertResponse> {
  return fetchJSON<CompassUpsertResponse>(`/api/compass/${encodeURIComponent(codebaseId)}/ghosts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function deleteCompassGhost(
  codebaseId: string,
  ghostId: string
): Promise<{ deleted: boolean; id: string }> {
  return fetchJSON(
    `/api/compass/${encodeURIComponent(codebaseId)}/ghosts/${encodeURIComponent(ghostId)}`,
    { method: 'DELETE' }
  );
}

export async function annotateCompassGhost(
  codebaseId: string,
  ghostId: string
): Promise<CompassAnnotateResponse> {
  return fetchJSON<CompassAnnotateResponse>(
    `/api/compass/${encodeURIComponent(codebaseId)}/annotate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ghostId }),
    }
  );
}

export async function promoteCompassGhost(
  codebaseId: string,
  ghostId: string,
  target: CompassPromoteTarget
): Promise<CompassPromoteResponse> {
  return fetchJSON<CompassPromoteResponse>(
    `/api/compass/${encodeURIComponent(codebaseId)}/promote`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ghostId, target }),
    }
  );
}
