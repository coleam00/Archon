import { requestJson } from '../lib/http';
import { toMessage, type Message } from '../primitives/message';

export async function listMessages(conversationId: string, limit = 500): Promise<Message[]> {
  const raw = await requestJson<Parameters<typeof toMessage>[0][]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit.toString()}`
  );
  return raw.map(toMessage);
}
