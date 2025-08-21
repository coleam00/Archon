/**
 * Crawl Progress Service
 * 
 * Uses Socket.IO for better reliability, automatic reconnection,
 * and improved connection management.
 */

import { knowledgeSocketIO, WebSocketService } from './socketIOService';

// Define types for crawl progress
export interface WorkerProgress {
  worker_id: string;
  status: string;
  progress: number;
  current_url?: string;
  pages_crawled: number;
  total_pages: number;
  message?: string;
  batch_num?: number;
}

// Simplified batch progress interface
export interface BatchProgress {
  completedBatches: number;
  totalBatches: number;
  currentBatch: number;
  activeWorkers: number;
  chunksInBatch: number;
  totalChunksInBatch: number;
}

export interface CrawlProgressData {
  progressId: string;
  status: string;
  percentage: number;
  currentStep?: string;
  logs?: string[];
  log?: string;
  workers?: WorkerProgress[];  // Updated to support new worker format
  error?: string;
  completed?: boolean;
  // Additional properties for document upload and crawling
  uploadType?: 'document' | 'crawl';
  fileName?: string;
  fileType?: string;
  currentUrl?: string;
  chunksStored?: number;
  processedPages?: number;
  totalPages?: number;
  wordCount?: number;
  duration?: string;
  sourceId?: string;
  codeExamplesCount?: number;
  // Original crawl parameters for retry functionality
  originalCrawlParams?: {
    url: string;
    knowledge_type?: 'technical' | 'business';
    tags?: string[];
    update_frequency?: number;
    max_depth?: number;
    crawl_options?: {
      max_concurrent?: number;
    };
  };
  // Original upload parameters for retry functionality
  originalUploadParams?: {
    file: File;
    tags?: string[];
    knowledge_type?: string;
  };
  // Simplified batch progress (snake_case from backend)
  completed_batches?: number;
  total_batches?: number;
  current_batch?: number;
  active_workers?: number;
  chunks_in_batch?: number;
  total_chunks_in_batch?: number;
  // Legacy fields
  totalJobs?: number;
  parallelWorkers?: number;
  // Camel case aliases for convenience
  completedBatches?: number;
  totalBatches?: number;
  currentBatch?: number;
  activeWorkers?: number;
  chunksInBatch?: number;
  totalChunksInBatch?: number;
}

export interface ProgressStep {
  name: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  percentage: number;
}

interface StreamProgressOptions {
  autoReconnect?: boolean;
  reconnectDelay?: number;
  connectionTimeout?: number;
}

type ProgressCallback = (data: CrawlProgressData) => void;

class CrawlProgressService {
  private wsService: WebSocketService = knowledgeSocketIO;
  private activeSubscriptions: Map<string, () => void> = new Map();
  private messageHandlers: Map<string, ProgressCallback> = new Map();
  private isConnected: boolean = false;

  /**
   * Stream crawl progress with Socket.IO
   */
  async streamProgress(
    progressId: string,
    onMessage: ProgressCallback,
    options: StreamProgressOptions = {}
  ): Promise<void> {
    console.log(`🚀 Starting Socket.IO progress stream for ${progressId}`);
    
    // Store the active crawl progress ID in localStorage for reconnection
    localStorage.setItem('activeCrawlProgressId', progressId);

    try {
      // Ensure we're connected to Socket.IO
      if (!this.wsService.isConnected()) {
        console.log('📡 Connecting to Socket.IO server...');
        // Connect to the base endpoint - the service will handle the correct path
        await this.wsService.connect(`/crawl-progress/${progressId}`);
        console.log('✅ Connected to Socket.IO server');
      }

      // Wait for connection to be fully established with increased timeout
      console.log('⏳ Waiting for connection to be fully established...');
      await this.wsService.waitForConnection(10000); // Increased timeout
      this.isConnected = this.wsService.isConnected();
      console.log(`✅ Socket.IO connection verified, connected: ${this.isConnected}`);

      // Set up acknowledgment promise
      let subscriptionAcknowledged = false;
      const ackPromise = new Promise<void>((resolve, reject) => {
        const ackTimeout = setTimeout(() => {
          if (!subscriptionAcknowledged) {
            reject(new Error('Subscription acknowledgment timeout'));
          }
        }, 5000); // 5 second timeout for acknowledgment

        // Listen for subscription acknowledgment
        const ackHandler = (message: { data?: Record<string, unknown>; progress_id?: string; status?: string }) => {
          const data = message.data || message;
          console.log(`📨 Received acknowledgment:`, data);
          if (data.progress_id === progressId && data.status === 'subscribed') {
            console.log(`✅ Subscription acknowledged for ${progressId}`);
            subscriptionAcknowledged = true;
            clearTimeout(ackTimeout);
            this.wsService.removeMessageHandler('crawl_subscribe_ack', ackHandler);
            resolve();
          }
        };
        this.wsService.addMessageHandler('crawl_subscribe_ack', ackHandler);
      });

      // Create a specific handler for this progressId
      const progressHandler = (message: { data?: CrawlProgressData; progressId?: string }) => {
        console.log(`📨 [${progressId}] Raw message received:`, message);
        const data = message.data || message;
        console.log(`📨 [${progressId}] Extracted data:`, data);
        console.log(`📨 [${progressId}] Data progressId: ${data.progressId}, Expected: ${progressId}`);
        
        // Only process messages for this specific progressId
        if (data.progressId === progressId) {
          console.log(`✅ [${progressId}] Progress match! Processing message`);
          onMessage(data);
        } else {
          console.log(`❌ [${progressId}] Progress ID mismatch: got ${data.progressId}`);
        }
      };

      // Store the handler so we can remove it later
      this.messageHandlers.set(progressId, progressHandler);

      // Add message handlers
      this.wsService.addMessageHandler('crawl_progress', progressHandler);

      // Also listen for legacy event names for backward compatibility
      this.wsService.addMessageHandler('progress_update', progressHandler);

      this.wsService.addMessageHandler('crawl_complete', (message) => {
        const data = message.data || message;
        console.log(`✅ Crawl completed for ${progressId}`);
        if (data.progressId === progressId) {
          onMessage({ ...data, completed: true });
          // Clear the stored progress ID when crawl completes
          localStorage.removeItem('activeCrawlProgressId');
        }
      });

      this.wsService.addMessageHandler('crawl_error', (message) => {
        console.error(`❌ Crawl error for ${progressId}:`, message);
        if (message.data?.progressId === progressId || message.progressId === progressId) {
          onMessage({ 
            progressId,
            status: 'error',
            error: message.data?.message || message.error || 'Unknown error',
            percentage: 0
          });
          // Clear the stored progress ID on error
          localStorage.removeItem('activeCrawlProgressId');
        }
      });

      // Add stop event handlers
      this.wsService.addMessageHandler('crawl:stopping', (message) => {
        if (message.data?.progressId === progressId) {
          onMessage({
            progressId,
            status: 'stopping',
            percentage: message.data.percentage || 0,
            log: message.data.message
          });
        }
      });
      
      this.wsService.addMessageHandler('crawl:stopped', (message) => {
        if (message.data?.progressId === progressId) {
          onMessage({
            progressId,
            status: 'cancelled',
            percentage: 100,
            completed: true,
            log: message.data.message
          });
          
          // Auto-cleanup after stop
          setTimeout(() => this.stopStreaming(progressId), 1000);
        }
      });

      // Subscribe to the crawl progress with retry logic
      console.log(`📤 Sending crawl_subscribe for ${progressId}`);
      const subscribeMessage = {
        type: 'crawl_subscribe',
        data: { progress_id: progressId }
      };
      console.log('📤 Subscribe message:', JSON.stringify(subscribeMessage));
      
      // Send subscription with retry
      let sent = false;
      let retries = 0;
      while (!sent && retries < 3) {
        sent = this.wsService.send(subscribeMessage);
        if (!sent) {
          console.warn(`⚠️ Failed to send subscription, retrying... (attempt ${retries + 1})`);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
          retries++;
        }
      }
      
      if (!sent) {
        throw new Error('Failed to send subscription after 3 attempts');
      }
      
      console.log(`📤 Message sent successfully: ${sent}`);

      // Wait for acknowledgment
      try {
        await ackPromise;
        console.log(`✅ Subscription confirmed for ${progressId}`);
      } catch (ackError) {
        console.error(`❌ Subscription acknowledgment failed:`, ackError);
        // Continue anyway - the subscription might still work
      }

      // Store cleanup function
      this.activeSubscriptions.set(progressId, () => {
        this.stopStreaming(progressId);
      });

    } catch (error) {
      console.error(`❌ Failed to start progress stream for ${progressId}:`, error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Stop streaming progress for a specific ID
   */
  stopStreaming(progressId: string): void {
    console.log(`🛑 Stopping progress stream for ${progressId}`);
    
    // Send unsubscribe message
    if (this.isConnected) {
      this.wsService.send({
        type: 'crawl_unsubscribe',
        data: { progress_id: progressId }
      });
    }
    
    // Remove the specific handler for this progressId
    const handler = this.messageHandlers.get(progressId);
    if (handler) {
      this.wsService.removeMessageHandler('crawl_progress', handler);
      this.wsService.removeMessageHandler('progress_update', handler);
      this.messageHandlers.delete(progressId);
    }
    
    // Remove from active subscriptions
    this.activeSubscriptions.delete(progressId);
    
    // Clear from localStorage if this is the active crawl
    const storedId = localStorage.getItem('activeCrawlProgressId');
    if (storedId === progressId) {
      localStorage.removeItem('activeCrawlProgressId');
    }
  }

  /**
   * Stop all active streams
   */
  stopAllStreams(): void {
    console.log('🛑 Stopping all progress streams');
    
    // Stop each active subscription
    for (const [progressId] of this.activeSubscriptions) {
      this.stopStreaming(progressId);
    }
    
    // Clear all handlers
    this.messageHandlers.clear();
    
    // Note: We don't disconnect the shared Socket.IO connection
    // as it may be used by other services
  }

  /**
   * Check if currently streaming for a progress ID
   */
  isStreaming(progressId: string): boolean {
    return this.activeSubscriptions.has(progressId);
  }

  /**
   * Get connection state
   */
  getConnectionState(): boolean {
    return this.isConnected && this.wsService.isConnected();
  }

  /**
   * Manually trigger reconnection
   */
  async reconnect(): Promise<void> {
    console.log('🔄 Reconnecting to Socket.IO server...');
    this.isConnected = false;
    
    // CRITICAL: Never disconnect the shared Socket.IO connection!
    // This was causing the entire app to lose connection during crawls
    // Just clear our handlers and resubscribe
    console.warn('⚠️ Reconnect called - clearing handlers only, NOT disconnecting shared socket');
    
    // Resubscribe all active subscriptions
    const activeProgressIds = Array.from(this.activeSubscriptions.keys());
    if (activeProgressIds.length > 0) {
      console.log(`🔄 Resubscribing to ${activeProgressIds.length} active progress streams...`);
      
      // Store handlers temporarily
      const tempHandlers = new Map(this.messageHandlers);
      
      // Clear current state
      this.activeSubscriptions.clear();
      this.messageHandlers.clear();
      
      // Reconnect and resubscribe
      for (const progressId of activeProgressIds) {
        const handler = tempHandlers.get(progressId);
        if (handler) {
          try {
            await this.streamProgress(progressId, handler);
            console.log(`✅ Resubscribed to ${progressId}`);
          } catch (error) {
            console.error(`❌ Failed to resubscribe to ${progressId}:`, error);
          }
        }
      }
    }
  }

  /**
   * Enhanced stream progress with additional callbacks
   */
  async streamProgressEnhanced(
    progressId: string,
    callbacks: {
      onMessage: ProgressCallback;
      onStateChange?: (state: string) => void;
      onError?: (error: Error) => void;
    },
    options: StreamProgressOptions = {}
  ): Promise<void> {
    // Use regular streamProgress with error handling
    try {
      await this.streamProgress(progressId, callbacks.onMessage, options);
      
      // Add state change handler if provided
      if (callbacks.onStateChange && this.wsService) {
        this.wsService.addStateChangeHandler(callbacks.onStateChange);
      }
      
      // Add error handler if provided
      if (callbacks.onError && this.wsService) {
        this.wsService.addErrorHandler(callbacks.onError);
      }
    } catch (error) {
      if (callbacks.onError) {
        callbacks.onError(error);
      }
      throw error;
    }
  }

  /**
   * Wait for connection to be established
   */
  async waitForConnection(timeout: number = 5000): Promise<void> {
    if (!this.wsService) {
      throw new Error('WebSocket service not initialized');
    }
    return this.wsService.waitForConnection(timeout);
  }

  /**
   * Disconnect the WebSocket service
   */
  disconnect(): void {
    console.log('🔌 Disconnecting crawl progress service');
    console.log(`📊 Active subscriptions before cleanup: ${this.activeSubscriptions.size}`);
    console.log(`📊 Active handlers before cleanup: ${this.messageHandlers.size}`);
    
    // Log the call stack to see what's triggering disconnects
    console.warn('⚠️ disconnect() called from:', new Error().stack);
    
    this.stopAllStreams();
    this.isConnected = false;
    
    // CRITICAL: We NEVER disconnect the shared Socket.IO connection
    // as it's used by other services (projects, tasks, etc.)
    console.log('✅ Cleared handlers without disconnecting shared Socket.IO instance');
    
    this.activeSubscriptions.clear();
    console.log('✅ Crawl progress service cleanup complete - Socket.IO connection preserved');
  }
}

// Export singleton instance
export const crawlProgressService = new CrawlProgressService();