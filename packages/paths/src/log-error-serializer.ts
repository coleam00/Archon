import pino from 'pino';

// Vendor SDK errors carry the request that failed: grammy's `payload` (a chat id,
// which is the user's id in a private chat, and the message text), discord.js's
// `requestBody` (message content) and Octokit's `request` (the comment body).
// pg constraint errors put the conflicting row values in `detail`.
// Generic handlers log these errors far from the code that threw them, so the
// logger drops those fields for every `err`. Message, code and status remain.
export function serializeLoggedError(err: Error): ReturnType<typeof pino.stdSerializers.err> {
  const serialized = pino.stdSerializers.err(err);
  // `throw null` and other non-objects reach here as-is.
  if (typeof serialized !== 'object' || serialized === null) return serialized;
  delete serialized.payload;
  delete serialized.requestBody;
  delete serialized.request;
  delete serialized.detail;
  return serialized;
}
