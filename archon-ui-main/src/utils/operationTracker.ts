/**
 * Operation tracking for Socket.IO echo suppression
 * Tracks outgoing operations to prevent processing their echoes
 */

// Using crypto.randomUUID instead of uuid package to avoid dependency bloat
const generateId = (): string => {
  return crypto.randomUUID();
};

export interface TrackedOperation {
  id: string;
  type: string;
  timestamp: number;
  payload: unknown;
  status: 'pending' | 'completed' | 'failed';
  timeout?: NodeJS.Timeout;
}

export interface OperationResult {
  operationId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export class OperationTracker {
  private operations: Map<string, TrackedOperation> = new Map();
  private operationTimeout: number = 30000; // 30 seconds default
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxOperationAge = 60000; // 1 minute

  constructor(timeout?: number) {
    if (timeout) {
      this.operationTimeout = timeout;
    }
    this.startCleanupInterval();
  }

  /**
   * Create a new tracked operation
   */
  createOperation(type: string, payload?: unknown): string {
    const operationId = generateId();
    
    // Set timeout for operation
    const timeout = setTimeout(() => {
      this.failOperation(operationId, 'Operation timed out');
    }, this.operationTimeout);

    const operation: TrackedOperation = {
      id: operationId,
      type,
      timestamp: Date.now(),
      payload,
      status: 'pending',
      timeout
    };

    this.operations.set(operationId, operation);
    return operationId;
  }

  /**
   * Check if an operation exists and is pending
   */
  isPending(operationId: string): boolean {
    const operation = this.operations.get(operationId);
    return operation?.status === 'pending';
  }

  /**
   * Check if an operation should be suppressed (exists and not failed)
   */
  shouldSuppress(operationId: string): boolean {
    const operation = this.operations.get(operationId);
    return operation !== undefined && operation.status !== 'failed';
  }

  /**
   * Mark an operation as completed
   */
  completeOperation(operationId: string, data?: unknown): OperationResult {
    const operation = this.operations.get(operationId);
    
    if (!operation) {
      return {
        operationId,
        success: false,
        error: 'Operation not found'
      };
    }

    // Clear timeout
    if (operation.timeout) {
      clearTimeout(operation.timeout);
    }

    operation.status = 'completed';
    
    return {
      operationId,
      success: true,
      data
    };
  }

  /**
   * Mark an operation as failed
   */
  failOperation(operationId: string, error: string): OperationResult {
    const operation = this.operations.get(operationId);
    
    if (!operation) {
      return {
        operationId,
        success: false,
        error: 'Operation not found'
      };
    }

    // Clear timeout
    if (operation.timeout) {
      clearTimeout(operation.timeout);
    }

    operation.status = 'failed';
    
    return {
      operationId,
      success: false,
      error
    };
  }

  /**
   * Get operation details
   */
  getOperation(operationId: string): TrackedOperation | undefined {
    return this.operations.get(operationId);
  }

  /**
   * Get all pending operations of a specific type
   */
  getPendingOperations(type?: string): TrackedOperation[] {
    const pending = Array.from(this.operations.values()).filter(
      op => op.status === 'pending'
    );
    
    if (type) {
      return pending.filter(op => op.type === type);
    }
    
    return pending;
  }

  /**
   * Clean up old operations to prevent memory leaks
   */
  private cleanup(): void {
    const now = Date.now();
    const idsToDelete: string[] = [];

    this.operations.forEach((operation, id) => {
      if (now - operation.timestamp > this.maxOperationAge) {
        // Clear timeout if still exists
        if (operation.timeout) {
          clearTimeout(operation.timeout);
        }
        idsToDelete.push(id);
      }
    });

    idsToDelete.forEach(id => this.operations.delete(id));
  }

  /**
   * Start periodic cleanup
   */
  private startCleanupInterval(): void {
    // Ensure we don't create multiple intervals
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Run cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 30000);
  }

  /**
   * Stop cleanup interval and clear all operations
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Clear all timeouts
    this.operations.forEach(operation => {
      if (operation.timeout) {
        clearTimeout(operation.timeout);
      }
    });

    this.operations.clear();
  }

  /**
   * Get statistics about tracked operations
   */
  getStats(): {
    total: number;
    pending: number;
    completed: number;
    failed: number;
  } {
    let pending = 0;
    let completed = 0;
    let failed = 0;

    this.operations.forEach(operation => {
      switch (operation.status) {
        case 'pending':
          pending++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    });

    return {
      total: this.operations.size,
      pending,
      completed,
      failed
    };
  }

  /**
   * Clear completed operations (keep pending and recently failed)
   */
  clearCompleted(): void {
    const now = Date.now();
    const idsToDelete: string[] = [];

    this.operations.forEach((operation, id) => {
      if (operation.status === 'completed' || 
          (operation.status === 'failed' && now - operation.timestamp > 5000)) {
        if (operation.timeout) {
          clearTimeout(operation.timeout);
        }
        idsToDelete.push(id);
      }
    });

    idsToDelete.forEach(id => this.operations.delete(id));
  }
}

// Singleton instance for global operation tracking
let globalTracker: OperationTracker | null = null;

export function getGlobalOperationTracker(): OperationTracker {
  if (!globalTracker) {
    globalTracker = new OperationTracker();
  }
  return globalTracker;
}

export function resetGlobalOperationTracker(): void {
  if (globalTracker) {
    globalTracker.destroy();
    globalTracker = null;
  }
}