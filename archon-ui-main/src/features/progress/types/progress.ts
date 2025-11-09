/**
 * Progress Types for Knowledge Base Operations
 * Matches backend progress models
 */

export type ProgressStatus =
  | "starting"
  | "initializing"
  | "discovery"
  | "analyzing"
  | "crawling"
  | "processing"
  | "source_creation"
  | "document_storage"
  | "code_extraction"
  | "finalization"
  | "reading"
  | "text_extraction"
  | "chunking"
  | "summarizing"
  | "storing"
  | "completed"
  | "error"
  | "failed"
  | "cancelled"
  | "stopping";

export type CrawlType =
  | "normal"
  | "sitemap"
  | "llms-txt"
  | "text_file"
  | "refresh"
  | "llms_txt_with_linked_files"
  | "llms_txt_linked_files"
  | "discovery_single_file"
  | "discovery_sitemap";
export type UploadType = "document";

export interface BaseProgressData {
  progressId: string;
  status: ProgressStatus;
  progress: number;
  message?: string;
  error?: string;
  startTime?: Date;
  logs?: string[];
}

export interface CrawlProgressData extends BaseProgressData {
  type: "crawl";
  crawlType?: CrawlType;
  currentUrl?: string;
  totalPages?: number;
  processedPages?: number;
  currentStep?: string;
  pagesFound?: number;
  codeBlocksFound?: number;
  totalSummaries?: number;
  completedSummaries?: number;
  // Discovery-related fields
  discoveredFile?: string;
  discoveredFileType?: string;
  linkedFiles?: string[];
  originalCrawlParams?: {
    url: string;
    knowledge_type?: string;
    tags?: string[];
    max_depth?: number;
  };
}

export interface UploadProgressData extends BaseProgressData {
  type: "upload";
  uploadType: UploadType;
  fileName?: string;
  fileSize?: number;
  chunksProcessed?: number;
  totalChunks?: number;
}

export type ProgressData = CrawlProgressData | UploadProgressData;

// Progress response from backend (camelCase from API)
// Response from /api/progress/ list endpoint
export interface ActiveOperation {
  operation_id: string;
  operation_type: string;
  status: string;
  progress: number;
  message: string;
  started_at: string;
  // Component-friendly aliases
  progressId: string; // Same as operation_id, for component compatibility
  type?: string; // Same as operation_type
  url?: string; // Original URL being crawled
  source_id?: string; // Source ID for matching to knowledge items
  // Additional fields that might come from backend
  current_url?: string;
  pages_crawled?: number;
  total_pages?: number;
  code_blocks_found?: number;
  documents_created?: number;
  crawl_type?: string; // Type of crawl (normal, sitemap, refresh, etc.)
  stats?: {
    pages_crawled?: number;
    documents_created?: number;
    errors?: number;
  };
  progress_data?: {
    percentage?: number;
    pages_crawled?: number;
    documents_processed?: number;
    code_examples_found?: number;
    current_operation?: string;
  };
  // Discovery information
  discovered_file?: string;
  discovered_file_type?: string;
  linked_files?: string[];
}

export interface ActiveOperationsResponse {
  operations: ActiveOperation[];
  count: number;
  timestamp: string;
}

export interface ProgressResponse {
  progressId: string;
  type?: "crawl" | "upload";
  status: ProgressStatus;
  progress: number;
  message?: string;
  error?: string;
  error_message?: string; // Alternative error field
  url?: string; // The URL being crawled
  currentUrl?: string;
  currentAction?: string; // Current action being performed
  current_step?: string; // Current step description
  crawlType?: CrawlType;
  totalPages?: number;
  processedPages?: number;
  pagesFound?: number;
  codeBlocksFound?: number;
  totalSummaries?: number;
  completedSummaries?: number;
  // Discovery-related fields
  discoveredFile?: string;
  discovered_file?: string; // Snake case from backend
  discoveredFileType?: string;
  discovered_file_type?: string; // Snake case from backend
  linkedFiles?: string[];
  linked_files?: string[]; // Snake case from backend
  fileName?: string;
  fileSize?: number;
  chunksProcessed?: number;
  totalChunks?: number;
  logs?:
    | string[]
    | Array<{
        timestamp: string;
        message: string;
        status?: string;
        progress?: number;
      }>;
  timestamp?: string;
  startedAt?: string; // ISO date string of when operation started
  stats?: {
    pages_crawled?: number;
    documents_created?: number;
    errors?: number;
  };
  progress_data?: {
    percentage?: number;
    pages_crawled?: number;
    documents_processed?: number;
    code_examples_found?: number;
    current_operation?: string;
  };
}

// Failed operation types for error visibility feature
export interface FailedOperation extends ProgressResponse {
  status: "error" | "failed";
  error: string; // Error message (required for failed operations)
  error_time?: string; // ISO timestamp of when error occurred
  original_request?: {
    // For retry functionality - original parameters
    url: string;
    max_depth?: number;
    max_concurrent?: number;
    tags?: string[];
  };
}

export interface FailedOperationsResponse {
  operations: FailedOperation[];
  count: number;
  timestamp: string;
}
