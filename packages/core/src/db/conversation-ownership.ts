import type { TransactionQuery } from './resource-slots';
import { ConversationNotFoundError } from '../types';

export async function lockConversationOwnership(
  query: TransactionQuery,
  conversationIds: readonly string[]
): Promise<void> {
  for (const id of [...new Set(conversationIds)].sort()) {
    // This write takes PostgreSQL's row lock and SQLite's writer lock before reads.
    const result = await query('UPDATE remote_agent_conversations SET id = id WHERE id = $1', [id]);
    if (result.rowCount !== 1) throw new ConversationNotFoundError(id);
  }
}
