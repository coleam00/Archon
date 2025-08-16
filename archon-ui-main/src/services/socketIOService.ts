/**
 * Socket.IO WebSocket Service
 * 
 * Features:
 * - Socket.IO for better reliability and reconnection
 * - Connection state management
 * - Promise-based connection establishment
 * - Automatic reconnection with exponential backoff
 * - Typed message handlers
 * - Support for dynamic endpoints
 * - Built-in heartbeat/keepalive
 * - Better error handling and recovery
 */

import { io, Socket } from 'socket.io-client';

export enum WebSocketState {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  DISCONNECTED = 'DISCONNECTED',
  FAILED = 'FAILED'
}

export interface WebSocketConfig {
  maxReconnectAttempts?: number;
  reconnectInterval?: number;
  heartbeatInterval?: number;
  messageTimeout?: number;
  enableHeartbeat?: boolean;
  enableAutoReconnect?: boolean;
}

export interface WebSocketMessage {
  type: string;
  data?: any;
  timestamp?: string;
  [key: string]: any;
}

type MessageHandler = (message: WebSocketMessage) => void;
type ErrorHandler = (error: Event | Error) => void;
type StateChangeHandler = (state: WebSocketState) => void;

export class WebSocketService {
  private socket: Socket | null = null;
  private config: Required<WebSocketConfig>;
  private sessionId: string = '';
  
  private messageHandlers: Map<string, MessageHandler[]> = new Map();
  private errorHandlers: ErrorHandler[] = [];
  private stateChangeHandlers: StateChangeHandler[] = [];
  private connectionPromise: Promise<void> | null = null;
  private connectionResolver: (() => void) | null = null;
  private connectionRejector: ((error: Error) => void) | null = null;
  
  private _state: WebSocketState = WebSocketState.DISCONNECTED;
  
  // Deduplication support
  private lastMessages: Map<string, { data: any; timestamp: number }> = new Map();
  private deduplicationWindow = 100; // 100ms window

  constructor(config: WebSocketConfig = {}) {
    this.config = {
      maxReconnectAttempts: 5,
      reconnectInterval: 1000,
      heartbeatInterval: 30000,
      messageTimeout: 60000,
      enableHeartbeat: true,
      enableAutoReconnect: true,
      ...config
    };
  }

  get state(): WebSocketState {
    return this._state;
  }

  private setState(newState: WebSocketState): void {
    if (this._state !== newState) {
      this._state = newState;
      this.notifyStateChange(newState);
    }
  }

  /**
   * Connect to Socket.IO with promise-based connection establishment
   */
  async connect(endpoint: string): Promise<void> {
    // Extract session ID from endpoint for room identification
    const { sessionId } = this.parseEndpoint(endpoint);
    
    // If already connected with the same session, return existing connection
    if (this.socket && this.state === WebSocketState.CONNECTED && this.sessionId === sessionId) {
      return Promise.resolve();
    }

    // If currently connecting, return existing promise
    if (this.connectionPromise && this.state === WebSocketState.CONNECTING) {
      return this.connectionPromise;
    }

    // Disconnect if session changed
    if (this.socket && this.sessionId !== sessionId) {
      this.disconnect();
    }

    this.sessionId = sessionId;
    this.setState(WebSocketState.CONNECTING);

    // Create connection promise
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectionResolver = resolve;
      this.connectionRejector = reject;
    });

    try {
      await this.establishConnection();
      return this.connectionPromise;
    } catch (error) {
      this.setState(WebSocketState.FAILED);
      throw error;
    }
  }

  private parseEndpoint(endpoint: string): { sessionId: string } {
    // Simplified endpoint parsing - focus on project IDs for task updates
    const projectMatch = endpoint.match(/projects\/([^/]+)/);
    if (projectMatch) {
      return { sessionId: projectMatch[1] };
    }
    
    // Legacy support for other endpoint types
    const sessionMatch = endpoint.match(/sessions\/([^/]+)/);
    const progressMatch = endpoint.match(/crawl-progress\/([^/]+)/);
    const projectProgressMatch = endpoint.match(/project-creation-progress\/([^/]+)/);
    
    const sessionId = sessionMatch?.[1] || progressMatch?.[1] || projectProgressMatch?.[1] || '';
    return { sessionId };
  }

  private async establishConnection(): Promise<void> {
    // Use relative URL to go through Vite's proxy
    const socketPath = '/socket.io/';  // Use default Socket.IO path
    
    // Use window.location.origin to ensure we go through the proxy
    const connectionUrl = window.location.origin;
    
    try {
      console.log('🔗 Attempting Socket.IO connection to:', connectionUrl);
      console.log('🔗 Socket.IO path:', socketPath);
      console.log('🔗 Session ID:', this.sessionId);
      
      // Connect to default namespace with explicit origin to ensure proxy usage
      this.socket = io(connectionUrl, {
        reconnection: this.config.enableAutoReconnect,
        reconnectionAttempts: this.config.maxReconnectAttempts,
        reconnectionDelay: this.config.reconnectInterval,
        reconnectionDelayMax: 30000,
        timeout: 10000,
        transports: ['polling', 'websocket'],
        path: socketPath,
        query: {
          session_id: this.sessionId
        }
      });
      
      console.log('🔗 Socket.IO instance created, setting up event handlers...');
      this.setupEventHandlers();
    } catch (error) {
      console.error('❌ Failed to create Socket.IO connection:', error);
      if (this.connectionRejector) {
        this.connectionRejector(error as Error);
      }
    }
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      console.log('🔌 Socket.IO connected successfully! Socket ID:', this.socket?.id);
      this.setState(WebSocketState.CONNECTED);
      
      // Resolve connection promise
      if (this.connectionResolver) {
        this.connectionResolver();
        this.connectionResolver = null;
        this.connectionRejector = null;
      }
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log(`🔌 Socket.IO disconnected. Reason: ${reason}`);
      
      // Socket.IO handles reconnection automatically based on the reason
      if (reason === 'io server disconnect') {
        // Server initiated disconnect, won't auto-reconnect
        this.setState(WebSocketState.DISCONNECTED);
      } else if (reason === 'transport close' || reason === 'transport error') {
        // Network issue, will auto-reconnect
        this.setState(WebSocketState.RECONNECTING);
      } else {
        // Client side disconnect, will auto-reconnect
        this.setState(WebSocketState.RECONNECTING);
      }
      
      // Don't reject connection promise for temporary disconnects
      if (this.connectionRejector && reason === 'io server disconnect') {
        this.connectionRejector(new Error(`Socket disconnected: ${reason}`));
        this.connectionResolver = null;
        this.connectionRejector = null;
      }
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('❌ Socket.IO connection error:', error);
      console.error('❌ Error type:', (error as any).type);
      console.error('❌ Error message:', error.message);
      console.error('❌ Socket transport:', this.socket?.io?.engine?.transport?.name);
      this.notifyError(error);
      
      // Reject connection promise if still pending
      if (this.connectionRejector) {
        this.connectionRejector(error);
        this.connectionResolver = null;
        this.connectionRejector = null;
      }
    });

    this.socket.on('reconnect', (attemptNumber: number) => {
      // Socket.IO reconnected
      this.setState(WebSocketState.CONNECTED);
    });

    this.socket.on('reconnect_attempt', (attemptNumber: number) => {
      // Socket.IO reconnection attempt
      this.setState(WebSocketState.RECONNECTING);
    });

    this.socket.on('reconnect_failed', () => {
      console.error('Socket.IO reconnection failed');
      this.setState(WebSocketState.FAILED);
    });

    // Handle incoming messages
    this.socket.onAny((eventName: string, ...args: any[]) => {
      // Skip internal Socket.IO events
      if (eventName.startsWith('connect') || eventName.startsWith('disconnect') || 
          eventName.startsWith('reconnect') || eventName === 'error') {
        return;
      }
      
      // Convert Socket.IO event to WebSocket message format
      const message: WebSocketMessage = {
        type: eventName,
        data: args[0],
        timestamp: new Date().toISOString()
      };
      
      // Handle specific message types
      if (eventName === 'message' && args[0]) {
        // Chat message format
        Object.assign(message, args[0]);
      }
      
      this.handleMessage(message);
    });
  }

  private isDuplicateMessage(type: string, data: any): boolean {
    const lastMessage = this.lastMessages.get(type);
    if (!lastMessage) return false;
    
    const now = Date.now();
    const timeDiff = now - lastMessage.timestamp;
    
    // If message arrived within deduplication window and data is identical
    if (timeDiff < this.deduplicationWindow) {
      const isDupe = JSON.stringify(lastMessage.data) === JSON.stringify(data);
      if (isDupe) {
        console.log(`[Socket] Duplicate ${type} message filtered`);
        return true;
      }
    }
    
    return false;
  }

  private handleMessage(message: WebSocketMessage): void {
    // Add deduplication check
    if (this.isDuplicateMessage(message.type, message.data)) {
      return;
    }
    
    // Store message for deduplication
    this.lastMessages.set(message.type, {
      data: message.data,
      timestamp: Date.now()
    });
    
    // Clean old messages periodically
    if (this.lastMessages.size > 100) {
      const cutoff = Date.now() - 5000;
      for (const [key, value] of this.lastMessages.entries()) {
        if (value.timestamp < cutoff) {
          this.lastMessages.delete(key);
        }
      }
    }
    
    // Notify specific type handlers
    const handlers = this.messageHandlers.get(message.type) || [];
    handlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        console.error(`Error in message handler for type ${message.type}:`, error);
      }
    });
    
    // Notify wildcard handlers
    const wildcardHandlers = this.messageHandlers.get('*') || [];
    wildcardHandlers.forEach(handler => {
      try {
        handler(message);
      } catch (error) {
        console.error('Error in wildcard message handler:', error);
      }
    });
  }

  private notifyError(error: Event | Error): void {
    this.errorHandlers.forEach(handler => {
      try {
        handler(error);
      } catch (err) {
        console.error('Error in error handler:', err);
      }
    });
  }

  private notifyStateChange(state: WebSocketState): void {
    this.stateChangeHandlers.forEach(handler => {
      try {
        handler(state);
      } catch (error) {
        console.error('Error in state change handler:', error);
      }
    });
  }

  /**
   * Add message handler for specific message type
   * Use '*' to handle all message types
   */
  addMessageHandler(type: string, handler: MessageHandler): void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    this.messageHandlers.get(type)!.push(handler);
  }

  removeMessageHandler(type: string, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  addErrorHandler(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  removeErrorHandler(handler: ErrorHandler): void {
    const index = this.errorHandlers.indexOf(handler);
    if (index > -1) {
      this.errorHandlers.splice(index, 1);
    }
  }

  addStateChangeHandler(handler: StateChangeHandler): void {
    this.stateChangeHandlers.push(handler);
  }

  removeStateChangeHandler(handler: StateChangeHandler): void {
    const index = this.stateChangeHandlers.indexOf(handler);
    if (index > -1) {
      this.stateChangeHandlers.splice(index, 1);
    }
  }

  /**
   * Send a message via Socket.IO
   */
  send(data: any): boolean {
    if (!this.isConnected()) {
      console.warn('Cannot send message: Socket.IO not connected');
      return false;
    }
    
    try {
      // For Socket.IO, we emit events based on message type
      if (data.type) {
        this.socket!.emit(data.type, data.data || data);
      } else {
        // Default message event
        this.socket!.emit('message', data);
      }
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      return false;
    }
  }

  /**
   * Wait for connection to be established
   */
  async waitForConnection(timeout: number = 10000): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }
    
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, timeout);
      
      const checkConnection = () => {
        if (this.isConnected()) {
          clearTimeout(timeoutId);
          resolve();
        } else if (this.state === WebSocketState.FAILED) {
          clearTimeout(timeoutId);
          reject(new Error('Connection failed'));
        } else {
          setTimeout(checkConnection, 100);
        }
      };
      
      checkConnection();
    });
  }

  isConnected(): boolean {
    return this.socket?.connected === true;
  }

  /**
   * Configure deduplication window (in milliseconds)
   * @param windowMs - Time window for deduplication (default: 100ms)
   */
  setDeduplicationWindow(windowMs: number): void {
    this.deduplicationWindow = windowMs;
  }

  disconnect(): void {
    this.setState(WebSocketState.DISCONNECTED);
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.messageHandlers.clear();
    this.errorHandlers = [];
    this.stateChangeHandlers = [];
    this.sessionId = '';
    this.connectionPromise = null;
    this.connectionResolver = null;
    this.connectionRejector = null;
    this.lastMessages.clear(); // Clear deduplication cache
  }
}

// Export a factory function for creating instances with specific configurations
export function createWebSocketService(config?: WebSocketConfig): WebSocketService {
  return new WebSocketService(config);
}

// Export singleton instances for different features
export const knowledgeSocketIO = new WebSocketService();

// Export instances for backward compatibility
export const taskUpdateSocketIO = new WebSocketService();
export const projectListSocketIO = new WebSocketService();