import type { StartRunArgs } from '../primitives/launch';
export type { StartRunArgs } from '../primitives/launch';
import type { paths } from '../../../lib/api.generated';
import { HttpError, requestJson } from '../lib/http';

type WorkflowRunLaunchJson =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['application/json'];
type WorkflowRunLaunchMultipart =
  paths['/api/workflows/{name}/run']['post']['requestBody']['content']['multipart/form-data'];
type WorkflowRunBody = Pick<
  WorkflowRunLaunchJson,
  'conversationId' | 'message' | 'inputs' | 'tiers' | 'aliases'
>;

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
 *      A 4xx answer means the route refused the start before dispatching, so
 *      no run owns the conversation from step 1: startRun soft-deletes it and
 *      rethrows the refusal. A 5xx or a transport failure keeps it, because a
 *      proxy error can hide a start the server accepted.
 *
 *      With files attached the dispatch route accepts multipart/form-data,
 *      mirroring /api/conversations/:id/message. Without files we use JSON.
 */
export async function startRun({
  projectId,
  workflow,
  message,
  files,
  inputs,
  tiers,
  aliases,
}: StartRunArgs): Promise<void> {
  const conv = await requestJson('/api/conversations', 'post', { body: { codebaseId: projectId } });

  const hasInputs = inputs !== undefined && Object.keys(inputs).length > 0;
  const hasTiers = tiers !== undefined && Object.keys(tiers).length > 0;
  const hasAliases = aliases !== undefined && Object.keys(aliases).length > 0;

  const body = {
    conversationId: conv.conversationId,
    message,
    ...(hasInputs ? { inputs } : {}),
    ...(hasTiers ? { tiers } : {}),
    ...(hasAliases ? { aliases } : {}),
  } satisfies WorkflowRunBody;

  try {
    await requestJson('/api/workflows/{name}/run', 'post', {
      params: { name: workflow },
      body: files !== undefined && files.length > 0 ? buildRunForm(body, files) : body,
    });
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500) {
      await discardConversation(conv.conversationId);
    }
    throw err;
  }
}

/** The refusal is what the operator needs to see, so a failed cleanup is only logged. */
async function discardConversation(conversationId: string): Promise<void> {
  try {
    await requestJson('/api/conversations/{id}', 'delete', { params: { id: conversationId } });
  } catch (err) {
    console.warn('[console] start-run cleanup failed', { conversationId, err });
  }
}

function buildRunForm(body: WorkflowRunBody, files: File[]): FormData {
  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  const fields = {
    conversationId: body.conversationId,
    message: body.message,
    inputs: JSON.stringify(body.inputs),
    tiers: JSON.stringify(body.tiers),
    aliases: JSON.stringify(body.aliases),
  } satisfies { [Key in keyof Required<WorkflowRunBody>]: WorkflowRunLaunchMultipart[Key] };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.append(key, value);
    }
  }
  const filesKey = 'files' satisfies keyof WorkflowRunLaunchMultipart;
  for (const file of files) {
    form.append(filesKey, file, file.name);
  }
  return form;
}
