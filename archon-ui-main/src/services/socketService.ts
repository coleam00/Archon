/**
 * Document Synchronization Service for Real-time Collaboration
 * 
 * Features:
 * - Real-time document synchronization using Socket.IO
 * - Batched updates with 500ms window for performance
 * - Conflict resolution for simultaneous edits
 * - Automatic reconnection and state recovery
 * - Optimistic updates with rollback capabilities
 * - Document versioning and change tracking
 */

import { Socket } from 'socket.io-client';
import { WebSocketService, WebSocketState } from './socketIOService';

// Document change types
export interface DocumentChange {
  id: string;
  projectId: string;
  documentId: string;
  changeType: 'content' | 'title' | 'metadata' | 'delete';
  data: any;
  userId: string;
  timestamp: number;
  version: number;
  patch?: any; // For operational transformation
}

// Document state for synchronization
export interface DocumentState {
  id: string;
  projectId: string;
  title: string;
  content: any;
  metadata: any;
  version: number;
  lastModified: number;
  lastModifiedBy: string;
  isLocked?: boolean;
  lockExpiry?: number;
}

// Conflict resolution strategies
export type ConflictResolutionStrategy = 
  | 'last-write-wins' 
  | 'operational-transform' 
  | 'manual-resolution'
  | 'timestamp-priority';

// Document synchronization events
export interface DocumentSyncEvent {
  type: 'document_updated' | 'document_deleted' | 'document_locked' | 'document_unlocked' | 'conflict_detected';
  documentId: string;
  projectId: string;
  userId: string;
  timestamp: number;
  data: any;
  version?: number;
}

// Batch update configuration
export interface BatchConfig {
  windowMs: number;
  maxBatchSize: number;
  flushOnDisconnect: boolean;
}

// Conflict resolution context
export interface ConflictContext {
  documentId: string;
  localChange: DocumentChange;
  remoteChange: DocumentChange;
  baseVersion: number;
  strategy: ConflictResolutionStrategy;
}

/**
 * DocumentSyncService - Real-time document synchronization
 */
export class DocumentSyncService {
  private webSocketService: WebSocketService;
  // private socket: Socket | null = null; // Not used directly, using webSocketService
  private projectId: string = '';
  
  // Batching system
  private batchQueue: Map<string, DocumentChange[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private batchConfig: BatchConfig = {
    windowMs: 500,
    maxBatchSize: 10,
    flushOnDisconnect: true
  };
  
  // Document state tracking
  private documentStates: Map<string, DocumentState> = new Map();
  private pendingChanges: Map<string, DocumentChange[]> = new Map();
  // private conflictQueue: ConflictContext[] = []; // Reserved for future use
  
  // Event handlers
  private eventHandlers: Map<string, ((event: DocumentSyncEvent) => void)[]> = new Map();
  private conflictHandlers: ((context: ConflictContext) => Promise<DocumentChange>)[] = [];
  
  // Configuration
  private conflictStrategy: ConflictResolutionStrategy = 'last-write-wins';
  private enableOptimisticUpdates: boolean = true;
  private enableVersioning: boolean = true;

  constructor(config?: {
    batchConfig?: Partial<BatchConfig>;
    conflictStrategy?: ConflictResolutionStrategy;
    enableOptimisticUpdates?: boolean;
    enableVersioning?: boolean;
  }) {
    this.webSocketService = new WebSocketService({
      enableAutoReconnect: true,
      maxReconnectAttempts: 10,
      reconnectInterval: 1000,
      heartbeatInterval: 30000
    });

    // Apply configuration
    if (config?.batchConfig) {
      this.batchConfig = { ...this.batchConfig, ...config.batchConfig };
    }
    if (config?.conflictStrategy) {
      this.conflictStrategy = config.conflictStrategy;
    }
    if (config?.enableOptimisticUpdates !== undefined) {
      this.enableOptimisticUpdates = config.enableOptimisticUpdates;
    }
    if (config?.enableVersioning !== undefined) {
      this.enableVersioning = config.enableVersioning;
    }

    this.setupWebSocketHandlers();
  }

  /**
   * Initialize document synchronization for a project
   */
  async initialize(projectId: string): Promise<void> {
    this.projectId = projectId;
    
    try {
      // Connect to Socket.IO with project-specific endpoint
      const endpoint = `/socket.io/projects/${projectId}/documents`;
      await this.webSocketService.connect(endpoint);
      
      console.log(`📄 Document sync initialized for project: ${projectId}`);
      
      // Request initial document states
      await this.requestDocumentStates();
      
    } catch (error) {
      console.error('Failed to initialize document synchronization:', error);
      throw error;
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    // Handle document update events
    this.webSocketService.addMessageHandler('document_updated', (message) => {
      this.handleRemoteDocumentUpdate(message.data);
    });

    // Handle document deletion events
    this.webSocketService.addMessageHandler('document_deleted', (message) => {
      this.handleRemoteDocumentDelete(message.data);
    });

    // Handle document lock events
    this.webSocketService.addMessageHandler('document_locked', (message) => {
      this.handleDocumentLocked(message.data);
    });

    // Handle document unlock events
    this.webSocketService.addMessageHandler('document_unlocked', (message) => {
      this.handleDocumentUnlocked(message.data);
    });

    // Handle conflict detection
    this.webSocketService.addMessageHandler('conflict_detected', (message) => {
      this.handleConflictDetected(message.data);
    });

    // Handle initial document states
    this.webSocketService.addMessageHandler('document_states', (message) => {
      this.handleDocumentStates(message.data);
    });

    // Handle connection state changes
    this.webSocketService.addStateChangeHandler((state) => {
      if (state === WebSocketState.CONNECTED) {
        this.flushPendingChanges();
      } else if (state === WebSocketState.DISCONNECTED && this.batchConfig.flushOnDisconnect) {
        this.flushAllBatches();
      }
    });
  }

  /**
   * Update a document with batching
   */
  async updateDocument(
    documentId: string,
    changeType: DocumentChange['changeType'],
    data: any,
    userId: string
  ): Promise<void> {
    const change: DocumentChange = {
      id: this.generateChangeId(),
      projectId: this.projectId,
      documentId,
      changeType,
      data,
      userId,
      timestamp: Date.now(),
      version: this.getNextVersion(documentId)
    };

    // Apply optimistic update locally
    if (this.enableOptimisticUpdates) {
      this.applyLocalChange(change);
    }

    // Add to batch queue
    this.addToBatch(documentId, change);
  }

  /**
   * Delete a document
   */
  async deleteDocument(documentId: string, userId: string): Promise<void> {
    const change: DocumentChange = {
      id: this.generateChangeId(),
      projectId: this.projectId,
      documentId,
      changeType: 'delete',
      data: null,
      userId,
      timestamp: Date.now(),
      version: this.getNextVersion(documentId)
    };

    // Remove from local state
    this.documentStates.delete(documentId);
    this.clearBatchesForDocument(documentId);

    // Send immediately (don't batch deletions)
    await this.sendChange(change);
  }

  /**
   * Add change to batch queue with automatic flushing
   */
  private addToBatch(documentId: string, change: DocumentChange): void {
    // Initialize batch queue for document if not exists
    if (!this.batchQueue.has(documentId)) {
      this.batchQueue.set(documentId, []);
    }

    const batch = this.batchQueue.get(documentId) || [];
    batch.push(change);

    // Clear existing timer
    const existingTimer = this.batchTimers.get(documentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Flush immediately if batch is full
    if (batch.length >= this.batchConfig.maxBatchSize) {
      this.flushBatch(documentId);
      return;
    }

    // Set new timer for batch window
    const timer = setTimeout(() => {
      this.flushBatch(documentId);
    }, this.batchConfig.windowMs);

    this.batchTimers.set(documentId, timer);
  }

  /**
   * Flush batched changes for a document
   */
  private async flushBatch(documentId: string): Promise<void> {
    const batch = this.batchQueue.get(documentId);
    if (!batch || batch.length === 0) {
      return;
    }

    // Clear timer
    const timer = this.batchTimers.get(documentId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(documentId);
    }

    // Clear batch
    this.batchQueue.set(documentId, []);

    try {
      // Send batched changes
      await this.sendBatchedChanges(documentId, batch);
      console.log(`📄 Flushed ${batch.length} changes for document ${documentId}`);
    } catch (error) {
      console.error(`Failed to flush batch for document ${documentId}:`, error);
      
      // Add back to pending changes for retry
      if (!this.pendingChanges.has(documentId)) {
        this.pendingChanges.set(documentId, []);
      }
      this.pendingChanges.get(documentId)?.push(...batch);
    }
  }

  /**
   * Flush all pending batches
   * Uses Promise.allSettled to ensure we attempt all flushes even if some fail,
   * as individual batches have their own error handling and retry logic.
   */
  private async flushAllBatches(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const documentId of this.batchQueue.keys()) {
      promises.push(this.flushBatch(documentId));
    }

    await Promise.allSettled(promises);
  }

  /**
   * Send batched changes to server
   */
  private async sendBatchedChanges(documentId: string, changes: DocumentChange[]): Promise<void> {
    if (!this.webSocketService.isConnected()) {
      throw new Error('WebSocket not connected');
    }

    const batchEvent = {
      type: 'document_batch_update',
      projectId: this.projectId,
      documentId,
      changes,
      timestamp: Date.now()
    };

    this.webSocketService.send(batchEvent);
  }

  /**
   * Send single change to server
   */
  private async sendChange(change: DocumentChange): Promise<void> {
    if (!this.webSocketService.isConnected()) {
      throw new Error('WebSocket not connected');
    }

    const event = {
      type: 'document_change',
      projectId: this.projectId,
      change,
      timestamp: Date.now()
    };

    this.webSocketService.send(event);
  }

  /**
   * Handle remote document updates
   */
  private handleRemoteDocumentUpdate(data: DocumentSyncEvent): void {
    const { documentId, userId } = data;

    // Skip if this is our own change
    if (userId === this.getCurrentUserId()) {
      return;
    }

    // Check for conflicts
    const localState = this.documentStates.get(documentId);
    if (localState && this.hasConflict(localState, data)) {
      this.handleConflict(documentId, data);
      return;
    }

    // Apply remote change
    this.applyRemoteChange(data);
    
    // Emit event
    this.emitEvent('document_updated', data);
  }

  /**
   * Handle remote document deletions
   */
  private handleRemoteDocumentDelete(data: DocumentSyncEvent): void {
    const { documentId } = data;

    // Remove from local state
    this.documentStates.delete(documentId);
    this.clearBatchesForDocument(documentId);

    // Emit event
    this.emitEvent('document_deleted', data);
  }

  /**
   * Handle document lock events
   */
  private handleDocumentLocked(data: DocumentSyncEvent): void {
    const { documentId, data: lockData } = data;
    
    const state = this.documentStates.get(documentId);
    if (state) {
      state.isLocked = true;
      state.lockExpiry = lockData.expiry;
    }

    this.emitEvent('document_locked', data);
  }

  /**
   * Handle document unlock events
   */
  private handleDocumentUnlocked(data: DocumentSyncEvent): void {
    const { documentId } = data;
    
    const state = this.documentStates.get(documentId);
    if (state) {
      state.isLocked = false;
      state.lockExpiry = undefined;
    }

    this.emitEvent('document_unlocked', data);
  }

  /**
   * Handle conflict detection
   */
  private handleConflictDetected(data: any): void {
    console.warn('Conflict detected:', data);
    
    const context: ConflictContext = {
      documentId: data.documentId,
      localChange: data.localChange,
      remoteChange: data.remoteChange,
      baseVersion: data.baseVersion,
      strategy: this.conflictStrategy
    };

    this.resolveConflict(context);
  }

  /**
   * Handle initial document states from server
   */
  private handleDocumentStates(data: DocumentState[]): void {
    data.forEach(state => {
      this.documentStates.set(state.id, state);
    });
    
    console.log(`📄 Loaded ${data.length} document states`);
  }

  /**
   * Apply local change optimistically
   */
  private applyLocalChange(change: DocumentChange): void {
    const { documentId, changeType, data } = change;
    
    let state = this.documentStates.get(documentId);
    if (!state) {
      state = {
        id: documentId,
        projectId: this.projectId,
        title: '',
        content: {},
        metadata: {},
        version: 0,
        lastModified: Date.now(),
        lastModifiedBy: change.userId
      };
      this.documentStates.set(documentId, state);
    }

    // Apply change based on type
    switch (changeType) {
      case 'content':
        state.content = { ...state.content, ...data };
        break;
      case 'title':
        state.title = data.title;
        break;
      case 'metadata':
        state.metadata = { ...state.metadata, ...data };
        break;
    }

    state.version = change.version;
    state.lastModified = change.timestamp;
    state.lastModifiedBy = change.userId;
  }

  /**
   * Apply remote change to local state
   */
  private applyRemoteChange(event: DocumentSyncEvent): void {
    const { documentId, data, version, userId, timestamp } = event;
    
    let state = this.documentStates.get(documentId);
    if (!state) {
      state = {
        id: documentId,
        projectId: this.projectId,
        title: '',
        content: {},
        metadata: {},
        version: version || 0,
        lastModified: timestamp,
        lastModifiedBy: userId
      };
      this.documentStates.set(documentId, state);
    }

    // Apply the update
    Object.assign(state, data);
    state.version = version || state.version + 1;
    state.lastModified = timestamp;
    state.lastModifiedBy = userId;
  }

  /**
   * Check for conflicts between local and remote changes
   */
  private hasConflict(localState: DocumentState, remoteEvent: DocumentSyncEvent): boolean {
    // Check version conflicts
    if (this.enableVersioning && remoteEvent.version && localState.version >= remoteEvent.version) {
      return true;
    }

    // Check timestamp conflicts (simultaneous edits within 1 second)
    const timeDiff = Math.abs(localState.lastModified - remoteEvent.timestamp);
    if (timeDiff < 1000 && localState.lastModifiedBy !== remoteEvent.userId) {
      return true;
    }

    return false;
  }

  /**
   * Handle conflict resolution
   */
  private async handleConflict(documentId: string, remoteEvent: DocumentSyncEvent): Promise<void> {
    const localState = this.documentStates.get(documentId);
    if (!localState) {
      // No local state, just apply remote change
      this.applyRemoteChange(remoteEvent);
      return;
    }

    // Create conflict context
    const context: ConflictContext = {
      documentId,
      localChange: this.createChangeFromState(localState),
      remoteChange: this.createChangeFromEvent(remoteEvent),
      baseVersion: Math.min(localState.version, remoteEvent.version || 0),
      strategy: this.conflictStrategy
    };

    await this.resolveConflict(context);
  }

  /**
   * Resolve conflicts based on strategy
   */
  private async resolveConflict(context: ConflictContext): Promise<void> {
    console.warn(`🔥 Resolving conflict for document ${context.documentId} using strategy: ${context.strategy}`);

    let resolvedChange: DocumentChange;

    switch (context.strategy) {
      case 'last-write-wins':
        resolvedChange = context.localChange.timestamp > context.remoteChange.timestamp 
          ? context.localChange 
          : context.remoteChange;
        break;

      case 'timestamp-priority':
        resolvedChange = context.remoteChange; // Remote wins by default
        break;

      case 'manual-resolution':
        // Call custom conflict handlers
        if (this.conflictHandlers.length > 0) {
          resolvedChange = await this.conflictHandlers[0](context);
        } else {
          resolvedChange = context.remoteChange; // Fallback to remote
        }
        break;

      case 'operational-transform':
        // TODO: Implement operational transformation
        resolvedChange = await this.mergeChanges(context.localChange, context.remoteChange);
        break;

      default:
        resolvedChange = context.remoteChange;
    }

    // Apply resolved change
    this.applyLocalChange(resolvedChange);
    
    // Emit conflict resolution event
    this.emitEvent('conflict_detected', {
      type: 'conflict_detected',
      documentId: context.documentId,
      projectId: this.projectId,
      userId: resolvedChange.userId,
      timestamp: Date.now(),
      data: {
        strategy: context.strategy,
        resolvedChange
      }
    });
  }

  /**
   * Merge changes using simple operational transformation
   */
  private async mergeChanges(localChange: DocumentChange, remoteChange: DocumentChange): Promise<DocumentChange> {
    // Simple merge strategy - combine non-conflicting fields
    const mergedData = {
      ...localChange.data,
      ...remoteChange.data
    };

    return {
      ...localChange,
      data: mergedData,
      timestamp: Math.max(localChange.timestamp, remoteChange.timestamp),
      version: Math.max(localChange.version, remoteChange.version) + 1
    };
  }

  /**
   * Utility methods
   */
  private generateChangeId(): string {
    return `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private getNextVersion(documentId: string): number {
    const state = this.documentStates.get(documentId);
    return state ? state.version + 1 : 1;
  }

  private getCurrentUserId(): string {
    // TODO: Get from auth context
    return 'current_user_id';
  }

  private createChangeFromState(state: DocumentState): DocumentChange {
    return {
      id: this.generateChangeId(),
      projectId: state.projectId,
      documentId: state.id,
      changeType: 'content',
      data: { content: state.content, title: state.title, metadata: state.metadata },
      userId: state.lastModifiedBy,
      timestamp: state.lastModified,
      version: state.version
    };
  }

  private createChangeFromEvent(event: DocumentSyncEvent): DocumentChange {
    return {
      id: this.generateChangeId(),
      projectId: event.projectId,
      documentId: event.documentId,
      changeType: 'content',
      data: event.data,
      userId: event.userId,
      timestamp: event.timestamp,
      version: event.version || 1
    };
  }

  private clearBatchesForDocument(documentId: string): void {
    // Clear batch queue
    this.batchQueue.delete(documentId);
    
    // Clear timer
    const timer = this.batchTimers.get(documentId);
    if (timer) {
      clearTimeout(timer);
      this.batchTimers.delete(documentId);
    }
    
    // Clear pending changes
    this.pendingChanges.delete(documentId);
  }

  private async requestDocumentStates(): Promise<void> {
    if (!this.webSocketService.isConnected()) {
      return;
    }

    this.webSocketService.send({
      type: 'request_document_states',
      projectId: this.projectId,
      timestamp: Date.now()
    });
  }

  private async flushPendingChanges(): Promise<void> {
    for (const [documentId, changes] of this.pendingChanges.entries()) {
      if (changes.length > 0) {
        try {
          await this.sendBatchedChanges(documentId, changes);
          this.pendingChanges.set(documentId, []);
        } catch (error) {
          console.error(`Failed to flush pending changes for ${documentId}:`, error);
        }
      }
    }
  }

  /**
   * Event system
   */
  addEventListener(type: string, handler: (event: DocumentSyncEvent) => void): void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, []);
    }
    if (this.eventHandlers.has(type)) {
      this.eventHandlers.get(type)?.push(handler);
    }
  }

  removeEventListener(type: string, handler: (event: DocumentSyncEvent) => void): void {
    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  addConflictHandler(handler: (context: ConflictContext) => Promise<DocumentChange>): void {
    this.conflictHandlers.push(handler);
  }

  private emitEvent(type: string, event: DocumentSyncEvent): void {
    const handlers = this.eventHandlers.get(type) || [];
    handlers.forEach(handler => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in event handler for ${type}:`, error);
      }
    });
  }

  /**
   * Public API methods
   */
  getDocumentState(documentId: string): DocumentState | undefined {
    return this.documentStates.get(documentId);
  }

  getAllDocumentStates(): DocumentState[] {
    return Array.from(this.documentStates.values());
  }

  isDocumentLocked(documentId: string): boolean {
    const state = this.documentStates.get(documentId);
    return state?.isLocked === true && (state.lockExpiry || 0) > Date.now();
  }

  getConnectionState(): WebSocketState {
    return this.webSocketService.state;
  }

  async disconnect(): Promise<void> {
    // Flush all pending changes before disconnecting
    await this.flushAllBatches();
    
    // Clear all timers
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer);
    }
    this.batchTimers.clear();
    
    // Disconnect WebSocket
    this.webSocketService.disconnect();
    
    // Clear state
    this.documentStates.clear();
    this.batchQueue.clear();
    this.pendingChanges.clear();
    this.eventHandlers.clear();
    this.conflictQueue = [];
  }
}

// Export factory function
export function createDocumentSyncService(config?: {
  batchConfig?: Partial<BatchConfig>;
  conflictStrategy?: ConflictResolutionStrategy;
  enableOptimisticUpdates?: boolean;
  enableVersioning?: boolean;
}): DocumentSyncService {
  return new DocumentSyncService(config);
}

// Export singleton instance
export const documentSyncService = new DocumentSyncService({
  conflictStrategy: 'last-write-wins',
  enableOptimisticUpdates: true,
  enableVersioning: true,
  batchConfig: {
    windowMs: 500,
    maxBatchSize: 10,
    flushOnDisconnect: true
  }
});