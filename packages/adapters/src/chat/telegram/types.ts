/**
 * Message context passed to onMessage handler
 */
export interface TelegramMessageContext {
  conversationId: string;
  message: string;
  userId: number | undefined;
}
