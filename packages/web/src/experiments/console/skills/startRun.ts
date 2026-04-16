import { requestJson } from '../lib/http';

/**
 * Start a run: two-call sequence that hides the legacy conversation coupling.
 *
 * The backend's POST /api/workflows/:name/run requires a conversationId.
 * Rather than leak that into the console UI, this skill:
 *   1. POST /api/conversations { codebaseId } → get back a fresh conversation id
 *   2. POST /api/workflows/:name/run { conversationId, message } → start the run
 *
 * The word "conversation" appears nowhere in the console outside this file.
 * If the run-creation call fails, the orphaned conversation is cleaned up by
 * the backend's cleanup service — don't compensate client-side.
 */
export interface StartRunArgs {
  projectId: string;
  workflow: string;
  message: string;
}

export interface StartedRunRef {
  runId: string;
  conversationId: string;
}

interface CreateConversationResponse {
  id: string;
  [k: string]: unknown;
}

interface RunWorkflowResponse {
  runId?: string;
  run_id?: string;
  id?: string;
  [k: string]: unknown;
}

function extractRunId(res: RunWorkflowResponse): string {
  const id = res.runId ?? res.run_id ?? res.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      'startRun: server response did not include a run id; check POST /api/workflows/:name/run schema.'
    );
  }
  return id;
}

export async function startRun({
  projectId,
  workflow,
  message,
}: StartRunArgs): Promise<StartedRunRef> {
  const conv = await requestJson<CreateConversationResponse>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ codebaseId: projectId }),
  });
  const conversationId = conv.id;

  const run = await requestJson<RunWorkflowResponse>(
    `/api/workflows/${encodeURIComponent(workflow)}/run`,
    {
      method: 'POST',
      body: JSON.stringify({ conversationId, message }),
    }
  );

  return { runId: extractRunId(run), conversationId };
}
