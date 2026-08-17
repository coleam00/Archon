import { requestJson, HttpError } from '../lib/http';

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
}

interface CreateConversationResponse {
  conversationId: string;
}

export async function startRun({
  projectId,
  workflow,
  message,
  files,
  inputs,
}: StartRunArgs): Promise<void> {
  const conv = await requestJson<CreateConversationResponse>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ codebaseId: projectId }),
  });

  const url = `/api/workflows/${encodeURIComponent(workflow)}/run`;

  const hasInputs = inputs !== undefined && Object.keys(inputs).length > 0;

  if (files === undefined || files.length === 0) {
    await requestJson<{ accepted: boolean; status: string }>(url, {
      method: 'POST',
      body: JSON.stringify({
        conversationId: conv.conversationId,
        message,
        ...(hasInputs ? { inputs } : {}),
      }),
    });
    return;
  }

  // Multipart path: don't set Content-Type — the browser adds the boundary.
  const form = new FormData();
  form.append('conversationId', conv.conversationId);
  form.append('message', message);
  // A form field can only be a string, so the input map travels JSON-encoded — the
  // shape the multipart branch of the run route parses.
  if (hasInputs) {
    form.append('inputs', JSON.stringify(inputs));
  }
  for (const file of files) {
    form.append('files', file, file.name);
  }
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(text) as { error?: string };
    } catch {
      /* not JSON */
    }
    // Match requestJson's 200-char truncation so a 502 HTML body doesn't
    // land in the error toast as raw markup.
    const raw = parsed.error ?? (text.length > 0 ? text : `HTTP ${res.status.toString()}`);
    const msg = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
    const path = new URL(url, window.location.origin).pathname;
    throw new HttpError(res.status, path, msg);
  }
}
