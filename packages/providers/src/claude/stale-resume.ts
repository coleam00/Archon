import type { MessageChunk } from '@archon/provider-contract';
import { sessionPreview } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import { claudeSessionTranscriptMissing } from './session-spend-reader';

/**
 * Claude rejects a resume of a missing session with an untyped `error_during_execution`,
 * the same subtype as a mid-turn crash. Only a host lookup that finds no transcript tells
 * them apart without reading the vendor's error text; a container run is never marked.
 */
export async function markStaleResume(
  chunk: MessageChunk,
  resumeSessionId: string | undefined,
  lookup: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; isContainerRun: boolean }
): Promise<MessageChunk> {
  if (
    chunk.type !== 'result' ||
    resumeSessionId === undefined ||
    lookup.isContainerRun ||
    chunk.failure?.class !== 'unknown' ||
    chunk.errorSubtype !== 'error_during_execution' ||
    (await claudeSessionTranscriptMissing(resumeSessionId, lookup)) !== true
  ) {
    return chunk;
  }
  createLogger('provider.claude').warn(
    { sessionIdPreview: sessionPreview(resumeSessionId) },
    'claude.resume_session_not_found'
  );
  return { ...chunk, sessionNotFound: true };
}
