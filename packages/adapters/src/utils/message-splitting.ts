import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('message-splitting');
  return cachedLog;
}

/**
 * Split a long message into chunks at paragraph boundaries.
 * Two-pass: first splits on paragraph breaks (\n\n), then falls back
 * to line breaks (\n) for any chunk still exceeding maxLength.
 */
export function splitIntoParagraphChunks(message: string, maxLength: number): string[] {
  if (!message) return [];

  const paragraphs = message.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    const newLength = currentChunk.length + para.length + 2; // +2 for \n\n

    if (newLength > maxLength && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  // Fallback: split by lines if any chunk is still too long
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLength) {
      finalChunks.push(chunk);
    } else {
      const lines = chunk.split('\n');
      let subChunk = '';
      for (const line of lines) {
        if (subChunk.length + line.length + 1 > maxLength) {
          if (subChunk) finalChunks.push(subChunk);
          subChunk = line;
        } else {
          subChunk += (subChunk ? '\n' : '') + line;
        }
      }
      if (subChunk) finalChunks.push(subChunk);
    }
  }

  getLog().debug({ chunkCount: finalChunks.length }, 'message.split_completed');
  return finalChunks;
}
