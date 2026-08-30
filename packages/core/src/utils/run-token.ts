import { createHmac, timingSafeEqual } from 'crypto';
import { getEncryptionKey } from './token-crypto';

const DOMAIN = 'archon-run-token-v1:';
export const RUN_TOKEN_PREFIX = 'art_';

export function deriveRunToken(runId: string): string {
  const mac = createHmac('sha256', getEncryptionKey())
    .update(DOMAIN + runId)
    .digest('hex');
  return RUN_TOKEN_PREFIX + mac;
}

export function verifyRunToken(runId: string, presented: string): boolean {
  if (!presented.startsWith(RUN_TOKEN_PREFIX)) return false;
  const expected = Buffer.from(deriveRunToken(runId).slice(RUN_TOKEN_PREFIX.length), 'hex');
  const got = Buffer.from(presented.slice(RUN_TOKEN_PREFIX.length), 'hex');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(expected, got);
}

// Session-scoped credential (orchestrator / direct-chat context — issue #223).
// Same HMAC construction as run tokens; distinguishable by the `ast_` prefix
// (Archon Session Token) vs `art_` (Archon Run Token).
const SESSION_DOMAIN = 'archon-session-token-v1:';
export const SESSION_TOKEN_PREFIX = 'ast_';

export function deriveSessionToken(conversationId: string): string {
  const mac = createHmac('sha256', getEncryptionKey())
    .update(SESSION_DOMAIN + conversationId)
    .digest('hex');
  return SESSION_TOKEN_PREFIX + mac;
}

export function verifySessionToken(conversationId: string, presented: string): boolean {
  if (!presented.startsWith(SESSION_TOKEN_PREFIX)) return false;
  const expected = Buffer.from(
    deriveSessionToken(conversationId).slice(SESSION_TOKEN_PREFIX.length),
    'hex'
  );
  const got = Buffer.from(presented.slice(SESSION_TOKEN_PREFIX.length), 'hex');
  if (got.length !== expected.length) return false;
  return timingSafeEqual(expected, got);
}
