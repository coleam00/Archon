import { requestJson } from '../lib/http';
import { toMessage, type Message } from '../primitives/message';

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  const raw = await requestJson('/api/conversations/{id}/messages', 'get', {
    params: { id: conversationId },
    query: { limit: limit.toString() },
  });
  return raw.map(toMessage);
}
