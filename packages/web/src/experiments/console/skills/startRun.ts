import { requestJson } from '../lib/http';

/**
 * Start a run: hides the legacy conversation coupling from the console UI.
 *
 *   1. POST /api/conversations           → { conversationId, id }
 *      - `conversationId` is the platform id (`web-<ts>-<rand>`); the dispatch
 *         route looks the conversation up by *platform* id, not DB UUID.
 *      - `id` is the DB UUID; workflow runs reference it via `parent_conversation_id`.
 *   2. POST /api/workflows/:name/run     → { accepted, status }
 *      - Fire-and-forget. Response does not include a run id; the orchestrator
 *        creates the workflow_run record asynchronously.
 *   3. Poll /api/dashboard/runs?codebaseId=…  until a run with the matching
 *      `parent_conversation_id` (our DB UUID) shows up; return its id.
 *
 * The word "conversation" appears nowhere in the console outside this file.
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
  conversationId: string;
  id: string;
}

interface DashboardRun {
  id: string;
  parent_conversation_id: string | null;
}

interface DashboardRunsResponse {
  runs: DashboardRun[];
}

// Workflow dispatch is async: orchestrator clones/creates the worktree, sets up
// the isolation env, and only then writes the workflow_run row. On a cold start
// this can take ~10-20s. Window has to be generous enough to swallow that, but
// short enough that a truly rejected dispatch still surfaces as an error.
const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 30_000;

async function pollForRun(codebaseId: string, parentConversationId: string): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await requestJson<DashboardRunsResponse>(
      `/api/dashboard/runs?codebaseId=${encodeURIComponent(codebaseId)}&limit=10`
    );
    const match = res.runs.find(r => r.parent_conversation_id === parentConversationId);
    if (match) return match.id;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `startRun: dispatch accepted but no workflow run record appeared within ${(POLL_TIMEOUT_MS / 1000).toString()}s. The run may still be starting — check the active list.`
  );
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

  await requestJson<{ accepted: boolean; status: string }>(
    `/api/workflows/${encodeURIComponent(workflow)}/run`,
    {
      method: 'POST',
      body: JSON.stringify({ conversationId: conv.conversationId, message }),
    }
  );

  const runId = await pollForRun(projectId, conv.id);
  return { runId, conversationId: conv.conversationId };
}
