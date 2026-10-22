/**
 * One fresh-session retry for a resume the provider reports as stale.
 *
 * The provider states the fact (`sessionNotFound` on a failed result, from a structured
 * check); this module owns the policy shared by chat turns and workflow AI nodes: at most one
 * retry per call, only when nothing but pre-turn setup reports came before the rejection, so
 * no output or tool execution can be duplicated. The caller decides whether a fresh fallback
 * is allowed at all; a named resume must not use this.
 */
import { createLogger } from '@archon/paths';
import { sessionPreview, type MessageChunk } from '@archon/provider-contract';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('session');
  return cachedLog;
}

/**
 * Chunks a provider may emit before the turn starts. Any other chunk means the turn produced
 * output or ran a tool, so a later rejection fails as before. An allowlist, so a new chunk
 * type defaults to no retry.
 */
const PRE_TURN_CHUNKS: ReadonlySet<MessageChunk['type']> = new Set([
  'warning',
  'mcp_server_status',
]);

export async function* withStaleResumeRetry(
  send: (resumeSessionId: string | undefined) => AsyncIterable<MessageChunk>,
  resumeSessionId: string | undefined,
  options: {
    /** Identifies the turn in the retry log; never prompt text or a full session id. */
    logContext: Record<string, unknown>;
    /** Runs after the stale result is dropped and before the fresh attempt starts. */
    onRetry?: (staleSessionId: string) => Promise<void>;
  }
): AsyncGenerator<MessageChunk> {
  if (resumeSessionId === undefined) {
    yield* send(undefined);
    return;
  }
  let turnStarted = false;
  let stale = false;
  for await (const chunk of send(resumeSessionId)) {
    if (chunk.type === 'result' && chunk.sessionNotFound === true && !turnStarted) {
      stale = true;
      break;
    }
    if (!PRE_TURN_CHUNKS.has(chunk.type)) turnStarted = true;
    yield chunk;
  }
  if (!stale) return;

  getLog().warn(
    { ...options.logContext, staleSessionIdPreview: sessionPreview(resumeSessionId) },
    'session.stale_resume_retry'
  );
  await options.onRetry?.(resumeSessionId);
  for await (const chunk of send(undefined)) {
    // `resumed: false` is the contract's "a resume was requested and the turn continued on a
    // fresh session", which callers already surface.
    yield chunk.type === 'result' ? { ...chunk, resumed: false } : chunk;
  }
}
