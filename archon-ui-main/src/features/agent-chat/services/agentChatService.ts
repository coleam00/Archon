import { callAPIWithETag, invalidateETagCache } from "../../projects/shared/apiWithEtag";

// Define the shape of the session and message objects for type safety
export interface ChatSession {
  session_id: string;
}

export interface ChatMessage {
  id: string;
  content: string;
  sender: "user" | "agent";
  timestamp: string;
}

export const agentChatService = {
  /**
   * Create a new chat session.
   */
  async createSession(): Promise<ChatSession> {
    try {
      const response = await callAPIWithETag<ChatSession>("/api/agent-chat/sessions", {
        method: "POST",
        body: JSON.stringify({}), // Empty body for now
      });
      return response;
    } catch (error) {
      console.error("Failed to create chat session:", error);
      throw error;
    }
  },

  /**
   * Send a message to a chat session.
   * @param sessionId The ID of the session.
   * @param message The message content to send.
   */
  async sendMessage(sessionId: string, message: string): Promise<{ status: string }> {
    try {
      const response = await callAPIWithETag<{ status: string }>(`/api/agent-chat/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      // Invalidate the message list for this session so the next poll gets fresh data
      invalidateETagCache(`/api/agent-chat/sessions/${sessionId}/messages`);
      return response;
    } catch (error) {
      console.error(`Failed to send message to session ${sessionId}:`, error);
      throw error;
    }
  },

  /**
   * Get all messages for a chat session.
   * @param sessionId The ID of the session.
   */
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    if (!sessionId) return [];
    try {
      const response = await callAPIWithETag<ChatMessage[]>(`/api/agent-chat/sessions/${sessionId}/messages`);
      return response || [];
    } catch (error) {
      console.error(`Failed to get messages for session ${sessionId}:`, error);
      // Return an empty array on error to prevent breaking the UI
      return [];
    }
  },
};
