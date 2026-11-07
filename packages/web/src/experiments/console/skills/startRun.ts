import type { paths } from '../../../lib/api.generated';
import { requestJson } from '../lib/http';
import type { TierName } from '../lib/tiers';

/**
 * Start a run: hides the legacy conversation coupling from the console UI.
 *
 *   1. POST /api/conversations           → { conversationId, id }
 *      `conversationId` is the platform id (`web-<ts>-<rand>`); the dispatch
 *      route looks the conversation up by platform id, not DB UUID.
 *   2. POST /api/workflows/:name/run     → { accepted, status }
 *      Fire-and-forget. The orchestrator creates the workflow_run row
 *      asynchronously after the HTTP response returns, so we deliberately do
 *      not wait for it here — callers should invalidate the runs cache and
 *      let the list polling surface the new run as it appears.
 *
 *      With files attached the dispatch route accepts multipart/form-data,
 *      mirroring /api/conversations/:id/message. Without files we use JSON.
 *
 * The word "conversation" appears nowhere in the console outside this file.
 */
export interface StartRunArgs {
  projectId: string;
  workflow: string;
  message: string;
  files?: File[];
  /**
   * Values for the workflow's declared `inputs:` (#2554), keyed by input name.
   * Omitted names take their declared default; a missing required input is refused by
   * the server before any worktree, clone, or AI cost.
   */
  inputs?: Record<string, string>;
  tiers?: Partial<Record<TierName, string>>;
  aliases?: Record<string, string>;
}

type WorkflowRunLaunchJson =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['application/json'];
type WorkflowRunLaunchMultipart =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['multipart/form-data'];
type WorkflowRunFormFields = Pick<
  WorkflowRunLaunchJson,
  keyof WorkflowRunLaunchJson & keyof WorkflowRunLaunchMultipart
>;

interface CreateConversationResponse {
  conversationId: string;
}

export async function startRun({
  projectId,
  workflow,
  message,
  files,
  inputs,
  tiers,
  aliases,
}: StartRunArgs): Promise<void> {
  const conv = await requestJson<CreateConversationResponse>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ codebaseId: projectId }),
  });

  const url = `/api/workflows/${encodeURIComponent(workflow)}/run`;

  const hasInputs = inputs !== undefined && Object.keys(inputs).length > 0;
  const hasTiers = tiers !== undefined && Object.keys(tiers).length > 0;
  const hasAliases = aliases !== undefined && Object.keys(aliases).length > 0;

  const body = {
    conversationId: conv.conversationId,
    message,
    ...(hasInputs ? { inputs } : {}),
    ...(hasTiers ? { tiers } : {}),
    ...(hasAliases ? { aliases } : {}),
  } satisfies WorkflowRunLaunchJson;

  await requestJson<{ accepted: boolean; status: string }>(url, {
    method: 'POST',
    body:
      files !== undefined && files.length > 0 ? buildRunForm(body, files) : JSON.stringify(body),
  });
}

function buildRunForm(body: WorkflowRunFormFields, files: File[]): FormData {
  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  for (const file of files) {
    form.append('files', file, file.name);
  }
  return form;
}
