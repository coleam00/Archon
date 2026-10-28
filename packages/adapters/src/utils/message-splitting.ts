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

  const chunks = collectParagraphChunks(message, maxLength);
  const finalChunks = chunks.flatMap(chunk =>
    chunk.length <= maxLength ? [chunk] : splitChunkByLines(chunk, maxLength)
  );

  getLog().debug({ chunkCount: finalChunks.length }, 'message.split_completed');
  return finalChunks;
}

function collectParagraphChunks(message: string, maxLength: number): string[] {
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

  return chunks;
}

function splitChunkByLines(chunk: string, maxLength: number): string[] {
  const chunks: string[] = [];
  const lines = chunk.split('\n');
  let subChunk = '';
  for (const line of lines) {
    if (subChunk.length + line.length + 1 > maxLength) {
      if (subChunk) chunks.push(subChunk);
      subChunk = line;
    } else {
      subChunk += (subChunk ? '\n' : '') + line;
    }
  }
  if (subChunk) chunks.push(subChunk);
  return chunks;
}
