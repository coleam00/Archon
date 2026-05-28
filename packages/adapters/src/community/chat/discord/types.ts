import type { Message } from 'discord.js';

/**
 * Normalized message context passed to the Discord onMessage handler.
 * The adapter extracts platformUserId and displayName from message.author
 * so the server never needs to know discord.js internals.
 */
export interface DiscordMessageContext {
  /** The raw discord.js Message (still needed for adapter-method calls) */
  message: Message;
  /** Discord snowflake (message.author.id) */
  platformUserId: string;
  /** message.author.username (display-quality, no extra API call needed) */
  displayName: string;
}
