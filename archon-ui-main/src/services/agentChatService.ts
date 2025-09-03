/**
 * Agent Chat Service
 * Handles communication with AI agents via REST API
 */

import { serverHealthService } from './serverHealthService';

export interface ChatMessage {
  id: string;
  content: string;
  sender: 'user' | 'agent';
  timestamp: Date;
  agent_type?: string;
}

interface ChatSession {
  session_id: string;
  project_id?: string;
  messages: ChatMessage[];
  agent_type: string;
  created_at: Date;
}

interface ChatRequest {
  message: string;
  project_id?: string;
  context?: Record<string, any>;
}

class AgentChatService {
  private baseUrl: string;
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private messageHandlers: Map<string, (message: ChatMessage) => void> = new Map();
  private errorHandlers: Map<string, (error: Error) => void> = new Map();
  private serverStatus: 'online' | 'offline' | 'unknown' = 'unknown';

  constructor() {
    // In development, the API is proxied through Vite, so we use the same origin
    // In production, this would be the actual API URL
    this.baseUrl = '';
  }

  /**
   * Clean up polling for a session
   */
  private cleanupConnection(sessionId: string): void {
    const interval = this.pollingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(sessionId);
    }
    
    this.messageHandlers.delete(sessionId);
    this.errorHandlers.delete(sessionId);
  }

  /**
   * Check if the chat server is online
   */
  private async checkServerStatus(): Promise<'online' | 'offline'> {
    try {
      const response = await fetch(`${this.baseUrl}/api/agent-chat/status`, {
        method: 'GET',
      });
      
      if (response.ok) {
        this.serverStatus = 'online';
        return 'online';
      } else {
        this.serverStatus = 'offline';
        return 'offline';
      }
    } catch (error) {
      console.error('Failed to check chat server status:', error);
      this.serverStatus = 'offline';
      return 'offline';
    }
  }

  /**
   * Validate a session exists
   */
  async validateSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions/${sessionId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.ok;
    } catch (error) {
      console.error('Failed to validate session:', error);
      return false;
    }
  }

  /**
   * Create or get an existing chat session
   */
  async createSession(agentType: string, projectId?: string): Promise<ChatSession> {
    try {
      const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_type: agentType,
          project_id: projectId
        }),
      });

      if (!response.ok) {
        // If we get a 404, the agent service is not running
        if (response.status === 404) {
          console.log('Agent chat service not available - service may be disabled');
          throw new Error('Agent chat service is not available. The service may be disabled.');
        }
        throw new Error(`Failed to create session: ${response.statusText}`);
      }

      const session = await response.json();
      return session;
    } catch (error) {
      // Don't log fetch errors for disabled service
      if (error instanceof Error && !error.message.includes('not available')) {
        console.error('Failed to create chat session:', error);
      }
      throw error;
    }
  }

  /**
   * Send a message to an existing chat session
   */
  async sendMessage(sessionId: string, request: ChatRequest): Promise<ChatMessage> {
    try {
      const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions/${sessionId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      const message = await response.json();
      return message;
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Stream messages from a chat session using polling
   */
  async streamMessages(
    sessionId: string,
    onMessage: (message: ChatMessage) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    // Store handlers
    this.messageHandlers.set(sessionId, onMessage);
    if (onError) {
      this.errorHandlers.set(sessionId, onError);
    }

    // Start polling for new messages
    let lastMessageId: string | null = null;
    
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions/${sessionId}/messages${lastMessageId ? `?after=${lastMessageId}` : ''}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          // If we get a 404, the service is not available - stop polling
          if (response.status === 404) {
            console.log('Agent chat service not available (404) - stopping polling');
            clearInterval(pollInterval);
            this.pollingIntervals.delete(sessionId);
            const errorHandler = this.errorHandlers.get(sessionId);
            if (errorHandler) {
              errorHandler(new Error('Agent chat service is not available'));
            }
            return;
          }
          throw new Error(`Failed to fetch messages: ${response.statusText}`);
        }

        const messages: ChatMessage[] = await response.json();
        
        // Process new messages
        for (const message of messages) {
          lastMessageId = message.id;
          const handler = this.messageHandlers.get(sessionId);
          if (handler) {
            handler(message);
          }
        }
      } catch (error) {
        // Only log non-404 errors (404s are handled above)
        if (error instanceof Error && !error.message.includes('404')) {
          console.error('Failed to poll messages:', error);
        }
        const errorHandler = this.errorHandlers.get(sessionId);
        if (errorHandler) {
          errorHandler(error instanceof Error ? error : new Error('Unknown error'));
        }
      }
    }, 1000); // Poll every second

    this.pollingIntervals.set(sessionId, pollInterval);
  }

  /**
   * Stop streaming messages from a session
   */
  stopStreaming(sessionId: string): void {
    this.cleanupConnection(sessionId);
  }

  /**
   * Get chat history for a session
   */
  async getChatHistory(sessionId: string): Promise<ChatMessage[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions/${sessionId}/messages`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get chat history: ${response.statusText}`);
      }

      const messages = await response.json();
      return messages;
    } catch (error) {
      console.error('Failed to get chat history:', error);
      throw error;
    }
  }

  /**
   * Delete a chat session
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      // Clean up any active connections first
      this.cleanupConnection(sessionId);

      const response = await fetch(`${this.baseUrl}/api/agent-chat/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to delete session: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to delete chat session:', error);
      throw error;
    }
  }

  /**
   * Get server status
   */
  async getServerStatus(): Promise<'online' | 'offline' | 'unknown'> {
    const serverHealthy = await serverHealthService.isHealthy();
    if (!serverHealthy) {
      this.serverStatus = 'offline';
      return 'offline';
    }

    return this.checkServerStatus();
  }

  /**
   * Clean up all connections
   */
  cleanup(): void {
    // Clean up all active polling
    this.pollingIntervals.forEach((interval) => {
      clearInterval(interval);
    });
    this.pollingIntervals.clear();
    this.messageHandlers.clear();
    this.errorHandlers.clear();
  }
}

export const agentChatService = new AgentChatService();