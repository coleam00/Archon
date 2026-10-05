import { randomBytes } from 'node:crypto';

export function generateConversationId(prefix: 'cli' | 'cli-chat' = 'cli'): string {
  return `${prefix}-${String(Date.now())}-${randomBytes(16).toString('hex')}`;
}
