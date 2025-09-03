/**
 * Detailed progress information
 */
export interface ProgressDetails {
  currentChunk?: number;
  totalChunks?: number;
  currentBatch?: number;
  totalBatches?: number;
  currentOperation?: string;
  chunksPerSecond?: number;
  estimatedTimeRemaining?: number;
  elapsedTime?: number;
  pagesCrawled?: number;
  totalPages?: number;
  embeddingsCreated?: number;
  codeBlocksFound?: number;
}

/**
 * Crawl progress data interface
 */
export interface CrawlProgressData {
  progressId: string;
  status: 'starting' | 'initializing' | 'crawling' | 'processing' | 'completed' | 'failed' | 'cancelled' | 
          'error' | 'stale' | 'stopping' | 'analyzing' | 'source_creation' | 'document_storage' | 
          'code_storage' | 'code_extraction' | 'finalization' | 'reading' | 'extracting' | 
          'chunking' | 'creating_source' | 'summarizing' | 'storing';
  currentUrl?: string;
  pagesQueued?: number;
  pagesVisited?: number;
  docsCreated?: number;
  progress: number;  // Required field representing progress 0-100
  message?: string;
  error?: string;
  result?: any;
  timestamp?: string;
  
  // Step information from backend
  currentStep?: string;
  stepMessage?: string;
  log?: string;
  logs?: string[];
  
  // Detailed progress information
  details?: ProgressDetails;
  
  // Upload-specific fields
  uploadType?: 'document' | 'crawl';
  fileName?: string;
  fileType?: string;
  
  // Crawl type for different formats
  crawlType?: 'normal' | 'sitemap' | 'llms-txt' | 'refresh';
  chunksStored?: number;
  wordCount?: number;
  sourceId?: string;
  duration?: string;
  
  // Batch processing fields
  totalPages?: number;
  processedPages?: number;
  parallelWorkers?: number;
  totalJobs?: number;
  completedBatches?: number;
  totalBatches?: number;
  total_batches?: number;
  completed_batches?: number;
  active_workers?: number;
  current_batch?: number;
  chunks_in_batch?: number;
  total_chunks_in_batch?: number;
  
  // Code extraction fields
  codeBlocksFound?: number;
  codeExamplesStored?: number;
  completedDocuments?: number;
  totalDocuments?: number;
  completedSummaries?: number;
  totalSummaries?: number;
  
  // Original parameters for retry functionality
  originalCrawlParams?: {
    url: string;
    knowledge_type: 'technical' | 'business';
    tags: string[];
    max_depth: number;
  };
  originalUploadParams?: {
    file: File;
    knowledge_type: 'technical' | 'business';
    tags: string[];
  };
  
  // For tracking start time
  startTime?: Date;
}