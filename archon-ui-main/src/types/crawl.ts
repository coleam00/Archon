/**
 * Crawl progress data interface
 */
export interface CrawlProgressData {
  progressId: string;
  status: 'starting' | 'crawling' | 'processing' | 'completed' | 'failed' | 'cancelled';
  currentUrl?: string;
  pagesQueued?: number;
  pagesVisited?: number;
  docsCreated?: number;
  progress?: number;
  message?: string;
  error?: string;
  result?: any;
  timestamp?: string;
  // Step information from backend
  currentStep?: string;
  stepMessage?: string;
}