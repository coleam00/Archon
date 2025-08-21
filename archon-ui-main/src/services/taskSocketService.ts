/**
 * Task Socket Service - Singleton Socket.IO Manager for Task Operations
 * 
 * This service provides a single, shared Socket.IO connection for all task-related
 * operations across the application. It prevents multiple connections and provides
 * proper room-based task synchronization.
 * 
 * Features:
 * - Singleton pattern to prevent multiple connections
 * - Project-based room management
 * - Automatic reconnection and state recovery
 * - Clean event handler management
 * - Proper session identification
 */

import { WebSocketState } from './socketIOService';
import sharedSocketInstance from './socketIOService';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'review' | 'done';
  assignee?: { name: string };
  task_order: number;
  feature?: string;
  featureColor?: string;
}

export interface TaskSocketEvents {
  onTaskCreated: (task: any) => void;
  onTaskUpdated: (task: any) => void;
  onTaskDeleted: (task: any) => void;
  onTaskArchived: (task: any) => void;
  onTasksReordered: (data: any) => void;
  onInitialTasks: (tasks: any[]) => void;
  onConnectionStateChange: (state: WebSocketState) => void;
}

class TaskSocketService {
  private static instance: TaskSocketService | null = null;
  private socketService: typeof sharedSocketInstance;
  private currentProjectId: string | null = null;
  private eventHandlers: Map<string, TaskSocketEvents> = new Map();
  private connectionPromise: Promise<void> | null = null;
  private isConnecting = false;
  private lastConnectionAttempt = 0;
  private connectionCooldown = 1000; // 1 second cooldown between connection attempts

  private constructor() {
    // Use the shared socket instance instead of creating a new one
    this.socketService = sharedSocketInstance;

    // Enable operation tracking for echo suppression
    this.socketService.enableOperationTracking();

    // Set up global event handlers
    this.setupGlobalHandlers();
  }

  public static getInstance(): TaskSocketService {
    if (!TaskSocketService.instance) {
      TaskSocketService.instance = new TaskSocketService();
    }
    return TaskSocketService.instance;
  }

  private setupGlobalHandlers(): void {
    // Handle connection state changes
    this.socketService.addStateChangeHandler((state: WebSocketState) => {
      console.log(`[TASK SOCKET] Connection state changed: ${state}`);
      this.notifyAllHandlers('onConnectionStateChange', state);
    });

    // Handle task-specific events with deduplication
    this.socketService.addMessageHandler('task_created', (message) => {
      console.log('[TASK SOCKET] Task created:', message.data);
      this.notifyAllHandlers('onTaskCreated', message.data);
    });

    this.socketService.addMessageHandler('task_updated', (message) => {
      console.log('[TASK SOCKET] Task updated:', message.data);
      this.notifyAllHandlers('onTaskUpdated', message);
    });

    this.socketService.addMessageHandler('task_deleted', (message) => {
      console.log('[TASK SOCKET] Task deleted:', message.data);
      this.notifyAllHandlers('onTaskDeleted', message.data);
    });

    this.socketService.addMessageHandler('task_archived', (message) => {
      console.log('[TASK SOCKET] Task archived:', message.data);
      this.notifyAllHandlers('onTaskArchived', message.data);
    });

    this.socketService.addMessageHandler('tasks_reordered', (message) => {
      console.log('[TASK SOCKET] Tasks reordered:', message.data);
      this.notifyAllHandlers('onTasksReordered', message.data);
    });

    this.socketService.addMessageHandler('initial_tasks', (message) => {
      console.log('[TASK SOCKET] Initial tasks received:', message.data);
      this.notifyAllHandlers('onInitialTasks', message.data);
    });

    this.socketService.addMessageHandler('joined_project', (message) => {
      console.log('[TASK SOCKET] Successfully joined project room:', message.data);
    });

    // Handle errors
    this.socketService.addErrorHandler((error) => {
      console.error('[TASK SOCKET] Socket error:', error);
    });
  }

  private notifyAllHandlers<K extends keyof TaskSocketEvents>(
    eventName: K, 
    data: Parameters<TaskSocketEvents[K]>[0]
  ): void {
    this.eventHandlers.forEach((handlers, componentId) => {
      const handler = handlers[eventName];
      if (handler) {
        try {
          (handler as any)(data);
        } catch (error) {
          console.error(`[TASK SOCKET] Error in ${eventName} handler for ${componentId}:`, error);
        }
      }
    });
  }

  /**
   * Connect to a project and join its task room with improved deduplication
   */
  public async connectToProject(projectId: string): Promise<void> {
    // Check cooldown to prevent rapid reconnection attempts
    const now = Date.now();
    if (now - this.lastConnectionAttempt < this.connectionCooldown) {
      console.log('[TASK SOCKET] Connection attempt too soon, using existing connection');
      if (this.connectionPromise) {
        return this.connectionPromise;
      }
    }

    // If already connected to the same project, return immediately
    if (this.currentProjectId === projectId && this.socketService.isConnected()) {
      console.log(`[TASK SOCKET] Already connected to project ${projectId}`);
      return Promise.resolve();
    }

    // If currently connecting to the same project, return existing promise
    if (this.isConnecting && this.currentProjectId === projectId && this.connectionPromise) {
      console.log(`[TASK SOCKET] Connection in progress for project ${projectId}, waiting...`);
      return this.connectionPromise;
    }

    this.lastConnectionAttempt = now;
    this.isConnecting = true;
    
    this.connectionPromise = this.performConnection(projectId);
    
    try {
      await this.connectionPromise;
    } finally {
      this.isConnecting = false;
      // Keep connection promise for a short time to allow deduplication
      setTimeout(() => {
        if (this.connectionPromise) {
          this.connectionPromise = null;
        }
      }, 500);
    }
  }

  private async performConnection(projectId: string): Promise<void> {
    try {
      console.log(`[TASK SOCKET] Connecting to project ${projectId}...`);

      // Disconnect from previous project if needed
      if (this.currentProjectId && this.currentProjectId !== projectId) {
        await this.leaveCurrentProject();
      }

      // Connect to socket with project-specific endpoint
      const endpoint = `/projects/${projectId}`;
      await this.socketService.connect(endpoint);

      // Join the project room
      console.log(`[TASK SOCKET] Joining project room: ${projectId}`);
      const joinSuccess = this.socketService.send({
        type: 'join_project',
        project_id: projectId
      }, true); // Enable operation tracking

      if (!joinSuccess) {
        throw new Error('Failed to send join_project message');
      }

      this.currentProjectId = projectId;
      console.log(`[TASK SOCKET] Successfully connected to project ${projectId}`);

    } catch (error) {
      console.error(`[TASK SOCKET] Failed to connect to project ${projectId}:`, error);
      this.currentProjectId = null;
      throw error;
    }
  }

  private async leaveCurrentProject(): Promise<void> {
    if (!this.currentProjectId) return;

    console.log(`[TASK SOCKET] Leaving current project: ${this.currentProjectId}`);
    this.socketService.send({
      type: 'leave_project',
      project_id: this.currentProjectId
    }, true); // Enable operation tracking

    this.currentProjectId = null;
  }

  /**
   * Register event handlers for a component with improved management
   */
  public registerHandlers(componentId: string, handlers: Partial<TaskSocketEvents>): void {
    console.log(`[TASK SOCKET] Registering handlers for component: ${componentId}`);
    
    // Merge with existing handlers if any
    const existingHandlers = this.eventHandlers.get(componentId) || {} as TaskSocketEvents;
    const mergedHandlers = { ...existingHandlers, ...handlers } as TaskSocketEvents;
    
    this.eventHandlers.set(componentId, mergedHandlers);
    
    console.log(`[TASK SOCKET] Total components with handlers: ${this.eventHandlers.size}`);
  }

  /**
   * Unregister event handlers for a component
   */
  public unregisterHandlers(componentId: string): void {
    console.log(`[TASK SOCKET] Unregistering handlers for component: ${componentId}`);
    this.eventHandlers.delete(componentId);
    
    console.log(`[TASK SOCKET] Remaining components with handlers: ${this.eventHandlers.size}`);
    
    // If no more handlers and no current project, consider disconnecting
    if (this.eventHandlers.size === 0 && this.currentProjectId) {
      console.log('[TASK SOCKET] No more handlers, scheduling cleanup...');
      // Delay cleanup to allow for component remounts
      setTimeout(() => {
        if (this.eventHandlers.size === 0) {
          console.log('[TASK SOCKET] Performing delayed cleanup');
          this.cleanup();
        }
      }, 5000);
    }
  }

  /**
   * Clean up resources when no handlers remain
   */
  private cleanup(): void {
    console.log('[TASK SOCKET] Cleaning up socket resources');
    if (this.currentProjectId) {
      this.leaveCurrentProject();
    }
    // Note: We don't disconnect the socket completely to allow for reconnection
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): WebSocketState {
    return this.socketService.state;
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.socketService.isConnected();
  }

  /**
   * Get current project ID
   */
  public getCurrentProjectId(): string | null {
    return this.currentProjectId;
  }

  /**
   * Disconnect from all projects and socket
   */
  public async disconnect(): Promise<void> {
    console.log('[TASK SOCKET] Disconnecting from all projects');
    
    if (this.currentProjectId) {
      await this.leaveCurrentProject();
    }

    this.socketService.disconnect();
    this.eventHandlers.clear();
    this.connectionPromise = null;
    this.isConnecting = false;
  }

  /**
   * Force reconnection to current project
   */
  public async reconnect(): Promise<void> {
    if (!this.currentProjectId) {
      console.warn('[TASK SOCKET] No current project to reconnect to');
      return;
    }

    const projectId = this.currentProjectId;
    this.currentProjectId = null; // Reset to force reconnection
    this.isConnecting = false;
    this.connectionPromise = null;
    
    await this.connectToProject(projectId);
  }
}

// Export singleton instance
export const taskSocketService = TaskSocketService.getInstance();
export default taskSocketService;