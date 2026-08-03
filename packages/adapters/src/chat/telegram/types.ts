/**
 * Message context passed to onMessage handler.
 * `displayName` is derived from ctx.from (first_name + last_name, fallback to
 * username); undefined if neither is present on the inbound event.
 */
export interface TelegramMessageContext {
  conversationId: string;
  message: string;
  userId: number | undefined;
  displayName?: string;
}
