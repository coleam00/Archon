/**
 * Conversation commands — list, get, messages, create, title, delete.
 *
 * Reads (list/get/messages) hit the database directly. Mutations (create,
 * title, delete) go through the REST API.
 */
import * as conversationDb from '@archon/core/db/conversations';
import * as messageDb from '@archon/core/db/messages';
import { createApiClient } from '../api-client';
import { confirmOrAbort } from '../prompt';

type Conversation = NonNullable<Awaited<ReturnType<typeof conversationDb.getConversationById>>>;

function formatDate(value: Date | string | null): string {
  if (value === null) return 'unknown';
  return value instanceof Date ? value.toISOString() : value;
}

/** Resolve a conversation by DB UUID first, then by platform conversation id. */
async function resolveConversation(id: string): Promise<Conversation> {
  const byId = await conversationDb.getConversationById(id);
  if (byId) return byId;
  const byPlatform = await conversationDb.findConversationByPlatformId(id);
  if (byPlatform) return byPlatform;
  throw new Error(`Conversation not found: ${id}`);
}

export async function conversationListCommand(opts: {
  limit?: number;
  json?: boolean;
}): Promise<void> {
  const conversations = await conversationDb.listConversations(opts.limit ?? 20);

  if (opts.json) {
    console.log(JSON.stringify({ conversations }, null, 2));
    return;
  }
  if (conversations.length === 0) {
    console.log('No conversations.');
    return;
  }
  for (const c of conversations) {
    console.log(`\n${c.title ?? '(untitled)'}`);
    console.log(`  ID:       ${c.id}`);
    console.log(`  Platform: ${c.platform_type} (${c.platform_conversation_id})`);
    console.log(`  Activity: ${formatDate(c.last_activity_at)}`);
  }
  console.log(`\nTotal: ${String(conversations.length)} conversation(s)`);
}

export async function conversationGetCommand(id: string, json?: boolean): Promise<void> {
  const c = await resolveConversation(id);
  if (json) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }
  console.log(`Title:    ${c.title ?? '(untitled)'}`);
  console.log(`ID:       ${c.id}`);
  console.log(`Platform: ${c.platform_type} (${c.platform_conversation_id})`);
  console.log(`Codebase: ${c.codebase_id ?? '(none)'}`);
  console.log(`Created:  ${formatDate(c.created_at)}`);
  console.log(`Activity: ${formatDate(c.last_activity_at)}`);
}

export async function conversationMessagesCommand(
  id: string,
  opts: { limit?: number; json?: boolean }
): Promise<void> {
  const c = await resolveConversation(id);
  const messages = await messageDb.listMessages(c.id, opts.limit ?? 50);

  if (opts.json) {
    console.log(JSON.stringify({ messages }, null, 2));
    return;
  }
  if (messages.length === 0) {
    console.log('No messages.');
    return;
  }
  for (const m of messages) {
    console.log(`\n[${m.role}] ${formatDate(m.created_at)}`);
    console.log(m.content);
  }
}

export async function conversationCreateCommand(
  opts: { title?: string; json?: boolean },
  serverUrl?: string
): Promise<void> {
  const api = createApiClient(serverUrl);
  const created = await api.post<{ conversationId: string; id: string; dispatched?: boolean }>(
    '/api/conversations',
    {}
  );

  // The create route is strict() and rejects a `title` field, so apply the
  // optional initial title via a follow-up PATCH.
  if (opts.title) {
    await api.patch(`/api/conversations/${encodeURIComponent(created.conversationId)}`, {
      title: opts.title,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify(created, null, 2));
    return;
  }
  console.log(`Created conversation: ${created.conversationId}`);
  console.log(`  DB id: ${created.id}`);
  if (opts.title) console.log(`  Title: ${opts.title}`);
}

export async function conversationTitleCommand(
  id: string,
  title: string,
  serverUrl?: string
): Promise<void> {
  const c = await resolveConversation(id);
  const api = createApiClient(serverUrl);
  await api.patch(`/api/conversations/${encodeURIComponent(c.platform_conversation_id)}`, {
    title,
  });
  console.log(`Updated title for conversation ${c.platform_conversation_id}.`);
}

export async function conversationDeleteCommand(
  id: string,
  force?: boolean,
  serverUrl?: string
): Promise<void> {
  const c = await resolveConversation(id);
  const confirmed = await confirmOrAbort(
    `Delete conversation "${c.title ?? c.platform_conversation_id}"?`,
    force
  );
  if (!confirmed) {
    console.error('Aborted.');
    return;
  }
  const api = createApiClient(serverUrl);
  await api.del(`/api/conversations/${encodeURIComponent(c.platform_conversation_id)}`);
  console.log(`Deleted conversation ${c.platform_conversation_id}.`);
}
