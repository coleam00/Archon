import { getWorkflowRun } from '../db/workflows';
import { getConversationById } from '../db/conversations';

/**
 * Resolve the acting Archon user ID from available context.
 *
 * Chain (first hit wins):
 *   1. workflow run row → run.user_id
 *   2. conversation row → conversation.user_id
 *   3. null (caller decides whether to throw or fall back)
 */
export async function resolveActingUserId(ctx: {
  runId?: string;
  conversationId?: string;
}): Promise<string | null> {
  if (ctx.runId) {
    const run = await getWorkflowRun(ctx.runId);
    if (run?.user_id) return run.user_id;
  }
  if (ctx.conversationId) {
    const conversation = await getConversationById(ctx.conversationId);
    if (conversation?.user_id) return conversation.user_id;
  }
  return null;
}
