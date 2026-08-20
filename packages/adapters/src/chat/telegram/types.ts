import type { Document, PhotoSize } from 'grammy/types';

/**
 * Message context passed to onMessage handler.
 * `displayName` is derived from ctx.from (first_name + last_name, fallback to
 * username); undefined if neither is present on the inbound event.
 * `document`/`photo` are the raw grammY attachment fields, present only when
 * the inbound message carried a file — `message` is `text ?? caption ?? ''`,
 * so an attachment-only message (no text, no caption) yields an empty string.
 * `unsupportedMediaLabel` is set when the message carries a media type this
 * feature does not download (video, voice, audio, animation, video note,
 * sticker) — so the shared "attachment could not be processed" notice still
 * reaches the user instead of the message being silently dropped.
 */
export interface TelegramMessageContext {
  conversationId: string;
  message: string;
  userId: number | undefined;
  displayName?: string;
  document?: Document;
  photo?: PhotoSize[];
  unsupportedMediaLabel?: string;
}
