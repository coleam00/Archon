import type { IDatabase } from './adapters/types';

export const WORKFLOW_ORIGIN_ANCHOR_ID = '00000000-0000-4000-8000-000000003640';
const PLATFORM_TYPE = 'archon';
const PLATFORM_ID = 'workflow-store-originless';

/**
 * SQL predicate excluding the anchor from a conversation lookup. Its platform ID is fixed
 * and public, so every lookup by a caller-supplied platform ID must treat it as absent.
 * The ID is a constant UUID, so inlining it is safe.
 */
export function notOriginAnchor(idColumn: string): string {
  return `${idColumn} <> '${WORKFLOW_ORIGIN_ANCHOR_ID}'`;
}

export function assertPublicConversation(id: string): void {
  if (id === WORKFLOW_ORIGIN_ANCHOR_ID) {
    throw new Error('The workflow origin compatibility anchor is reserved');
  }
}

export function assertPublicConversationIdentity(type: string, id: string): void {
  if (type === PLATFORM_TYPE && id === PLATFORM_ID) {
    throw new Error('The workflow origin compatibility anchor is reserved');
  }
}

// Both dialects retain the shipped conversation FK. Creation belongs to the run's
// transaction so a failed admission cannot leave a fabricated public conversation.
export async function ensureWorkflowOriginAnchor(
  query: Parameters<Parameters<IDatabase['withTransaction']>[0]>[0]
): Promise<string> {
  await query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id, hidden)
     VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
    [WORKFLOW_ORIGIN_ANCHOR_ID, PLATFORM_TYPE, PLATFORM_ID]
  );
  const result = await query<{
    id: string;
    platform_type: string;
    platform_conversation_id: string;
    hidden: boolean | number;
  }>(
    `SELECT id, platform_type, platform_conversation_id, hidden
       FROM remote_agent_conversations
      WHERE id = $1 OR (platform_type = $2 AND platform_conversation_id = $3)`,
    [WORKFLOW_ORIGIN_ANCHOR_ID, PLATFORM_TYPE, PLATFORM_ID]
  );
  const anchor = result.rows[0];
  if (
    result.rows.length !== 1 ||
    anchor?.id !== WORKFLOW_ORIGIN_ANCHOR_ID ||
    anchor.platform_type !== PLATFORM_TYPE ||
    anchor.platform_conversation_id !== PLATFORM_ID ||
    !(anchor.hidden === true || anchor.hidden === 1)
  ) {
    throw new Error('Conflicting workflow origin compatibility anchor');
  }
  return WORKFLOW_ORIGIN_ANCHOR_ID;
}
