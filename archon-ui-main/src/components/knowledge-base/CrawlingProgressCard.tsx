import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Globe,
  FileText,
  RotateCcw,
  X,
  FileCode,
  Upload,
  Search,
  Cpu,
  Database,
  Code,
  Zap,
  Square,
  Layers,
  Download
} from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { CrawlProgressData } from '../../types/crawl';
import { useCrawlProgressPolling } from '../../hooks/useCrawlQueries';
import { useTerminalScroll } from '../../hooks/useTerminalScroll';

interface CrawlingProgressCardProps {
  progressId: string;
  initialData?: Partial<CrawlProgressData>;
  onComplete?: (data: CrawlProgressData) => void;
  onError?: (error: string) => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  onStop?: () => void;
}

// Simple mapping of backend status to UI display
const STATUS_CONFIG = {
  // Common statuses
  'starting': { label: 'Starting', icon: <Activity className="w-4 h-4" />, color: 'blue' },
  'initializing': { label: 'Initializing', icon: <Activity className="w-4 h-4" />, color: 'blue' },
  
  // Crawl statuses
  'analyzing': { label: 'Analyzing URL', icon: <Search className="w-4 h-4" />, color: 'purple' },
  'crawling': { label: 'Crawling Pages', icon: <Globe className="w-4 h-4" />, color: 'blue' },
  'processing': { label: 'Processing Content', icon: <Cpu className="w-4 h-4" />, color: 'cyan' },
  'source_creation': { label: 'Creating Source', icon: <FileText className="w-4 h-4" />, color: 'indigo' },
  'document_storage': { label: 'Storing Documents', icon: <Database className="w-4 h-4" />, color: 'green' },
  'code_extraction': { label: 'Extracting Code', icon: <Code className="w-4 h-4" />, color: 'yellow' },
  'finalization': { label: 'Finalizing', icon: <Zap className="w-4 h-4" />, color: 'orange' },
  
  // Upload statuses
  'reading': { label: 'Reading File', icon: <Download className="w-4 h-4" />, color: 'blue' },
  'extracting': { label: 'Extracting Text', icon: <FileText className="w-4 h-4" />, color: 'blue' },
  'chunking': { label: 'Chunking Content', icon: <Cpu className="w-4 h-4" />, color: 'blue' },
  'creating_source': { label: 'Creating Source', icon: <Database className="w-4 h-4" />, color: 'blue' },
  'summarizing': { label: 'Generating Summary', icon: <Search className="w-4 h-4" />, color: 'purple' },
  'storing': { label: 'Storing Chunks', icon: <Database className="w-4 h-4" />, color: 'green' },
  
  // End states
  'completed': { label: 'Completed', icon: <CheckCircle className="w-4 h-4" />, color: 'green' },
  'error': { label: 'Error', icon: <AlertTriangle className="w-4 h-4" />, color: 'red' },
  'failed': { label: 'Failed', icon: <AlertTriangle className="w-4 h-4" />, color: 'red' },
  'cancelled': { label: 'Cancelled', icon: <X className="w-4 h-4" />, color: 'gray' },
  'stopping': { label: 'Stopping', icon: <Square className="w-4 h-4" />, color: 'orange' },
} as const;

export const CrawlingProgressCard: React.FC<CrawlingProgressCardProps> = ({
  progressId,
  initialData,
  onComplete,
  onError,
  onRetry,
  onDismiss,
  onStop
}) => {
  const [showDetailedProgress, setShowDetailedProgress] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  
  // Track completion/error handling
  const [hasHandledCompletion, setHasHandledCompletion] = useState(false);
  const [hasHandledError, setHasHandledError] = useState(false);
  
  // Poll for progress updates
  const { data: progressData } = useCrawlProgressPolling(progressId, {
    onError: (error: Error) => {
      if (error.message === 'Resource no longer exists') {
        if (onDismiss) {
          onDismiss();
        }
      }
    }
  });
  
  // Merge polled data with initial data - preserve important fields
  const displayData = progressData ? {
    ...initialData,
    ...progressData,
    // Ensure we don't lose these fields during polling
    currentUrl: progressData.currentUrl || progressData.current_url || initialData?.currentUrl,
    crawlType: progressData.crawlType || progressData.crawl_type || initialData?.crawlType,
  } : {
    progressId,
    status: 'starting',
    progress: 0,
    message: 'Initializing...',
    ...initialData
  } as CrawlProgressData;
  
  // Use terminal scroll hook for logs
  const logsContainerRef = useTerminalScroll(
    displayData?.logs || [], 
    showLogs
  );
  
  // Handle status changes
  useEffect(() => {
    if (!progressData) return;
    
    if (progressData.status === 'completed' && !hasHandledCompletion && onComplete) {
      setHasHandledCompletion(true);
      onComplete(progressData);
    } else if ((progressData.status === 'error' || progressData.status === 'failed') && !hasHandledError && onError) {
      setHasHandledError(true);
      onError(progressData.error || 'Unknown error');
    }
  }, [progressData?.status, hasHandledCompletion, hasHandledError, onComplete, onError]);
  
  // Get current status config with better fallback
  const statusConfig = (() => {
    const config = STATUS_CONFIG[displayData.status as keyof typeof STATUS_CONFIG];
    if (config) {
      return config;
    }
    
    // Better fallbacks based on progress
    if (displayData.progress >= 100) {
      return STATUS_CONFIG.completed;
    }
    if (displayData.progress > 90) {
      return STATUS_CONFIG.finalization;
    }
    
    // Log unknown statuses for debugging
    console.warn(`Unknown status: ${displayData.status}, progress: ${displayData.progress}%, message: ${displayData.message}`);
    
    return STATUS_CONFIG.processing;
  })();
  
  // Debug log for status transitions
  useEffect(() => {
    if (displayData.status === 'finalization' || 
        (displayData.status === 'starting' && displayData.progress > 90)) {
      console.log('Status transition debug:', {
        status: displayData.status,
        progress: displayData.progress,
        message: displayData.message,
        hasStatusConfig: !!STATUS_CONFIG[displayData.status as keyof typeof STATUS_CONFIG]
      });
    }
  }, [displayData.status, displayData.progress]);
  
  // Determine crawl type display
  const getCrawlTypeDisplay = () => {
    const crawlType = displayData.crawlType || 
      (displayData.uploadType === 'document' ? 'upload' : 'normal');
    
    switch (crawlType) {
      case 'sitemap':
        return { icon: <Layers className="w-4 h-4" />, label: 'Sitemap Crawl' };
      case 'llms-txt':
      case 'text_file':
        return { icon: <FileCode className="w-4 h-4" />, label: 'LLMs.txt Import' };
      case 'upload':
        return { icon: <Upload className="w-4 h-4" />, label: 'Document Upload' };
      default:
        return { icon: <Globe className="w-4 h-4" />, label: 'Web Crawl' };
    }
  };
  
  const crawlType = getCrawlTypeDisplay();
  
  // Handle stop
  const handleStop = async () => {
    if (isStopping || !onStop) return;
    setIsStopping(true);
    try {
      onStop();
    } finally {
      setIsStopping(false);
    }
  };
  
  // Get progress steps based on type
  const getProgressSteps = () => {
    const isUpload = displayData.uploadType === 'document';
    
    const steps = isUpload ? [
      'reading', 'extracting', 'chunking', 'creating_source', 'summarizing', 'storing'
    ] : [
      'analyzing', 'crawling', 'processing', 'source_creation', 'document_storage', 'code_extraction', 'finalization'
    ];
    
    return steps.map(stepId => {
      const config = STATUS_CONFIG[stepId as keyof typeof STATUS_CONFIG];
      const currentIndex = steps.indexOf(displayData.status || '');
      const stepIndex = steps.indexOf(stepId);
      
      let status: 'pending' | 'active' | 'completed' | 'error' = 'pending';
      
      if (displayData.status === 'completed') {
        status = 'completed';
      } else if (displayData.status === 'error' || displayData.status === 'failed') {
        status = stepIndex <= currentIndex ? 'error' : 'pending';
      } else if (stepIndex < currentIndex) {
        status = 'completed';
      } else if (stepIndex === currentIndex) {
        status = 'active';
      }
      
      return {
        id: stepId,
        label: config.label,
        icon: config.icon,
        status
      };
    });
  };
  
  const progressSteps = getProgressSteps();
  const isActive = !['completed', 'error', 'failed', 'cancelled'].includes(displayData.status || '');
  
  return (
    <Card className="relative overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Badge color={crawlType.label.includes('Sitemap') ? 'purple' : 'blue'} variant="solid">
          {crawlType.icon}
          <span className="ml-1">{crawlType.label}</span>
        </Badge>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`
              ${statusConfig.color === 'green' ? 'text-green-600 dark:text-green-400' :
                statusConfig.color === 'red' ? 'text-red-600 dark:text-red-400' :
                statusConfig.color === 'blue' ? 'text-blue-600 dark:text-blue-400' :
                statusConfig.color === 'purple' ? 'text-purple-600 dark:text-purple-400' :
                statusConfig.color === 'orange' ? 'text-orange-600 dark:text-orange-400' :
                'text-gray-600 dark:text-gray-400'}
              font-medium
            `}>
              {statusConfig.label}
            </span>
            {isActive && (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                {statusConfig.icon}
              </motion.div>
            )}
          </div>
          {displayData.currentUrl && (
            <p className="text-sm text-gray-500 dark:text-zinc-400 truncate">
              {displayData.currentUrl}
            </p>
          )}
        </div>
        
        {/* Stop button */}
        {isActive && onStop && (
          <Button
            onClick={handleStop}
            disabled={isStopping}
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 dark:text-red-400"
          >
            <Square className="w-4 h-4" />
          </Button>
        )}
      </div>
      
      {/* Main Progress Bar */}
      {isActive && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Overall Progress
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {Math.round(displayData.progress || 0)}%
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2">
            <motion.div
              className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-blue-600"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(0, Math.min(100, displayData.progress || 0))}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          
          {/* Current message with numeric progress */}
          {displayData.message && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {displayData.message}
              {displayData.status === 'crawling' && displayData.totalPages !== undefined && displayData.totalPages > 0 && (
                <span className="ml-2 font-medium">
                  ({displayData.processedPages || 0}/{displayData.totalPages} pages)
                </span>
              )}
            </p>
          )}
        </div>
      )}
      
      {/* Finalization Progress */}
      {isActive && displayData.status === 'finalization' && (
        <div className="mb-4 p-3 bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/20 rounded-md">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-orange-600 dark:text-orange-400 animate-pulse" />
            <span className="text-sm font-medium text-orange-700 dark:text-orange-400">
              Finalizing Results
            </span>
          </div>
          <p className="text-xs text-orange-600 dark:text-orange-400/80 mt-1">
            Completing crawl and saving final metadata...
          </p>
        </div>
      )}
      
      {/* Crawling Statistics - Show detailed crawl progress */}
      {isActive && displayData.status === 'crawling' && (displayData.totalPages > 0 || displayData.processedPages > 0) && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-md">
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Crawling Progress
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-blue-600 dark:text-blue-400/80">Pages Discovered</div>
              <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                {displayData.totalPages || 0}
              </div>
            </div>
            <div>
              <div className="text-xs text-blue-600 dark:text-blue-400/80">Pages Processed</div>
              <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                {displayData.processedPages || 0}
              </div>
            </div>
          </div>
          {displayData.currentUrl && (
            <div className="mt-2 pt-2 border-t border-blue-200/50 dark:border-blue-500/20">
              <div className="text-xs text-blue-600 dark:text-blue-400/80">Currently crawling:</div>
              <div className="text-xs text-blue-700 dark:text-blue-300 truncate mt-1">
                {displayData.currentUrl}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Code Extraction Progress - Special handling for long-running step */}
      {isActive && displayData.status === 'code_extraction' && (
        <div className="mb-4 p-3 bg-yellow-50 dark:bg-yellow-500/10 border border-yellow-200 dark:border-yellow-500/20 rounded-md">
          <div className="flex items-center gap-2 mb-2">
            <Code className="w-4 h-4 text-yellow-600 dark:text-yellow-400 animate-pulse" />
            <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Extracting Code Examples
            </span>
          </div>
          
          {/* Show document scanning progress if available */}
          {(displayData.completedDocuments !== undefined || displayData.totalDocuments !== undefined) && 
           displayData.completedDocuments < displayData.totalDocuments && (
            <div className="mb-2">
              <div className="text-xs text-yellow-600 dark:text-yellow-400/80">
                Scanning documents: {displayData.completedDocuments || 0} / {displayData.totalDocuments || 0}
              </div>
              <div className="w-full bg-yellow-200/50 dark:bg-yellow-700/30 rounded-full h-1.5 mt-1">
                <div 
                  className="h-1.5 rounded-full bg-yellow-500 dark:bg-yellow-400"
                  style={{ 
                    width: `${Math.round(((displayData.completedDocuments || 0) / Math.max(1, displayData.totalDocuments || 1)) * 100)}%` 
                  }}
                />
              </div>
            </div>
          )}
          
          {/* Show summary generation progress */}
          {(displayData.completedSummaries !== undefined || displayData.totalSummaries !== undefined) && displayData.totalSummaries > 0 && (
            <div className="mb-2">
              <div className="text-xs text-yellow-600 dark:text-yellow-400/80">
                Generating summaries: {displayData.completedSummaries || 0} / {displayData.totalSummaries || 0}
              </div>
              <div className="w-full bg-yellow-200/50 dark:bg-yellow-700/30 rounded-full h-1.5 mt-1">
                <div 
                  className="h-1.5 rounded-full bg-yellow-500 dark:bg-yellow-400"
                  style={{ 
                    width: `${Math.round(((displayData.completedSummaries || 0) / Math.max(1, displayData.totalSummaries || 1)) * 100)}%` 
                  }}
                />
              </div>
            </div>
          )}
          
          {/* Show code blocks found and stored */}
          <div className="grid grid-cols-2 gap-3">
            {displayData.codeBlocksFound !== undefined && (
              <div>
                <div className="text-xs text-yellow-600 dark:text-yellow-400/80">Code Blocks Found</div>
                <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                  {displayData.codeBlocksFound}
                </div>
              </div>
            )}
            {displayData.codeExamplesStored !== undefined && (
              <div>
                <div className="text-xs text-yellow-600 dark:text-yellow-400/80">Examples Stored</div>
                <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                  {displayData.codeExamplesStored}
                </div>
              </div>
            )}
          </div>
          
          {/* Fallback to details if main fields not available */}
          {!displayData.codeBlocksFound && displayData.details?.codeBlocksFound !== undefined && (
            <div className="flex items-center gap-4">
              <div>
                <span className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                  {displayData.details.codeBlocksFound}
                </span>
                <span className="text-sm text-yellow-600 dark:text-yellow-400 ml-2">
                  code blocks found
                </span>
              </div>
              {displayData.details?.totalChunks && (
                <div className="text-xs text-yellow-600 dark:text-yellow-400/60">
                  Scanning chunk {displayData.details.currentChunk || 0} of {displayData.details.totalChunks}
                </div>
              )}
            </div>
          )}
          
          <p className="text-xs text-yellow-600 dark:text-yellow-400/60 mt-2">
            {displayData.completedSummaries !== undefined && displayData.totalSummaries > 0 
              ? `Generating AI summaries for ${displayData.totalSummaries} code examples...`
              : displayData.completedDocuments !== undefined && displayData.totalDocuments > 0
              ? `Scanning ${displayData.totalDocuments} document(s) for code blocks...`
              : 'Analyzing content for code examples...'}
          </p>
        </div>
      )}
      
      {/* Real-time Processing Stats */}
      {isActive && displayData.status === 'document_storage' && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          {displayData.details?.currentChunk !== undefined && displayData.details?.totalChunks && (
            <div className="p-2 bg-blue-50 dark:bg-blue-500/10 rounded-md">
              <div className="text-xs text-blue-600 dark:text-blue-400 font-medium">Chunks Processing</div>
              <div className="text-lg font-bold text-blue-700 dark:text-blue-300">
                {displayData.details.currentChunk} / {displayData.details.totalChunks}
              </div>
              <div className="text-xs text-blue-600 dark:text-blue-400/80">
                {Math.round((displayData.details.currentChunk / displayData.details.totalChunks) * 100)}% complete
              </div>
            </div>
          )}
          
          {displayData.details?.embeddingsCreated !== undefined && (
            <div className="p-2 bg-green-50 dark:bg-green-500/10 rounded-md">
              <div className="text-xs text-green-600 dark:text-green-400 font-medium">Embeddings</div>
              <div className="text-lg font-bold text-green-700 dark:text-green-300">
                {displayData.details.embeddingsCreated}
              </div>
              <div className="text-xs text-green-600 dark:text-green-400/80">created</div>
            </div>
          )}
          
          {displayData.details?.codeBlocksFound !== undefined && displayData.status === 'code_extraction' && (
            <div className="p-2 bg-yellow-50 dark:bg-yellow-500/10 rounded-md">
              <div className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">Code Blocks</div>
              <div className="text-lg font-bold text-yellow-700 dark:text-yellow-300">
                {displayData.details.codeBlocksFound}
              </div>
              <div className="text-xs text-yellow-600 dark:text-yellow-400/80">extracted</div>
            </div>
          )}
          
          {displayData.details?.chunksPerSecond && (
            <div className="p-2 bg-purple-50 dark:bg-purple-500/10 rounded-md">
              <div className="text-xs text-purple-600 dark:text-purple-400 font-medium">Processing Speed</div>
              <div className="text-lg font-bold text-purple-700 dark:text-purple-300">
                {displayData.details.chunksPerSecond.toFixed(1)}
              </div>
              <div className="text-xs text-purple-600 dark:text-purple-400/80">chunks/sec</div>
            </div>
          )}
          
          {displayData.details?.estimatedTimeRemaining && (
            <div className="p-2 bg-orange-50 dark:bg-orange-500/10 rounded-md">
              <div className="text-xs text-orange-600 dark:text-orange-400 font-medium">Time Remaining</div>
              <div className="text-lg font-bold text-orange-700 dark:text-orange-300">
                {Math.ceil(displayData.details.estimatedTimeRemaining / 60)}m
              </div>
              <div className="text-xs text-orange-600 dark:text-orange-400/80">estimated</div>
            </div>
          )}
        </div>
      )}
      
      {/* Batch Processing Info - Enhanced */}
      {(() => {
        const shouldShowBatch = displayData.totalBatches && displayData.totalBatches > 0 && isActive && displayData.status === 'document_storage';
        return shouldShowBatch;
      })() && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-md">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-pulse" />
              <span className="text-sm font-medium text-blue-700 dark:text-blue-400">
                Batch Processing
              </span>
            </div>
            <span className="text-sm font-bold text-blue-600 dark:text-blue-400">
              {displayData.completedBatches || 0}/{displayData.totalBatches} batches
            </span>
          </div>
          
          {/* Batch progress bar */}
          <div className="w-full bg-blue-200 dark:bg-blue-900/50 rounded-full h-1.5 mb-2">
            <motion.div
              className="h-1.5 rounded-full bg-blue-500 dark:bg-blue-400"
              initial={{ width: 0 }}
              animate={{ 
                width: `${Math.round(((displayData.completedBatches || 0) / displayData.totalBatches) * 100)}%` 
              }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          
          <div className="grid grid-cols-2 gap-2 text-xs">
            {displayData.activeWorkers !== undefined && (
              <div className="text-blue-600 dark:text-blue-400/80">
                <span className="font-medium">{displayData.activeWorkers}</span> parallel {displayData.activeWorkers === 1 ? 'worker' : 'workers'}
              </div>
            )}
            
            {displayData.currentBatch && displayData.totalChunksInBatch && (
              <div className="text-blue-600 dark:text-blue-400/80">
                Current: <span className="font-medium">{displayData.chunksInBatch || 0}/{displayData.totalChunksInBatch}</span> chunks
              </div>
            )}
            
            {displayData.details?.totalChunks && (
              <div className="text-blue-600 dark:text-blue-400/80 col-span-2">
                Total progress: <span className="font-medium">{displayData.details.currentChunk || 0}/{displayData.details.totalChunks}</span> chunks processed
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Detailed Progress Steps */}
      {isActive && (
        <div className="mb-4">
          <button
            onClick={() => setShowDetailedProgress(!showDetailedProgress)}
            className="flex items-center gap-2 text-sm text-gray-600 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-white transition-colors"
          >
            <FileText className="w-4 h-4" />
            <span>Detailed Progress</span>
            {showDetailedProgress ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      )}
      
      <AnimatePresence>
        {showDetailedProgress && isActive && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden mb-4"
          >
            <div className="space-y-2 p-3 bg-gray-50 dark:bg-zinc-900/50 rounded-md">
              {progressSteps.map((step) => (
                <div key={step.id} className="flex items-center gap-3">
                  <div className={`
                    p-1.5 rounded-md
                    ${step.status === 'completed' ? 'bg-green-100 dark:bg-green-500/10 text-green-600 dark:text-green-400' :
                      step.status === 'active' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' :
                      step.status === 'error' ? 'bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400' :
                      'bg-gray-100 dark:bg-gray-500/10 text-gray-400 dark:text-gray-600'}
                  `}>
                    {step.status === 'active' ? (
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                      >
                        {step.icon}
                      </motion.div>
                    ) : (
                      step.icon
                    )}
                  </div>
                  <div className="flex-1">
                    <span className={`
                      text-sm
                      ${step.status === 'active' ? 'font-medium text-gray-700 dark:text-gray-300' :
                        step.status === 'completed' ? 'text-gray-600 dark:text-gray-400' :
                        'text-gray-400 dark:text-gray-600'}
                    `}>
                      {step.label}
                    </span>
                    
                    {/* Show detailed progress for active step */}
                    {step.status === 'active' && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {step.id === 'document_storage' && displayData.completedBatches !== undefined && displayData.totalBatches ? (
                          <span>Batch {displayData.completedBatches + 1} of {displayData.totalBatches}</span>
                        ) : step.id === 'code_extraction' && displayData.details?.codeBlocksFound !== undefined ? (
                          <span>{displayData.details.codeBlocksFound} code blocks found</span>
                        ) : step.id === 'crawling' && (displayData.processedPages !== undefined || displayData.totalPages !== undefined) ? (
                          <span>
                            {displayData.processedPages !== undefined ? displayData.processedPages : '?'} of {displayData.totalPages !== undefined ? displayData.totalPages : '?'} pages
                          </span>
                        ) : displayData.message ? (
                          <span>{displayData.message}</span>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Statistics */}
      {(displayData.status === 'completed' || !isActive) && (
        <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
          {displayData.totalPages && (
            <div>
              <span className="text-gray-500 dark:text-zinc-400">Pages:</span>
              <span className="ml-2 font-medium text-gray-800 dark:text-white">
                {displayData.processedPages || 0} / {displayData.totalPages}
              </span>
            </div>
          )}
          {displayData.chunksStored && (
            <div>
              <span className="text-gray-500 dark:text-zinc-400">Chunks:</span>
              <span className="ml-2 font-medium text-gray-800 dark:text-white">
                {displayData.chunksStored}
              </span>
            </div>
          )}
          {displayData.details?.embeddingsCreated && (
            <div>
              <span className="text-gray-500 dark:text-zinc-400">Embeddings:</span>
              <span className="ml-2 font-medium text-gray-800 dark:text-white">
                {displayData.details.embeddingsCreated}
              </span>
            </div>
          )}
          {displayData.details?.codeBlocksFound && (
            <div>
              <span className="text-gray-500 dark:text-zinc-400">Code Blocks:</span>
              <span className="ml-2 font-medium text-gray-800 dark:text-white">
                {displayData.details.codeBlocksFound}
              </span>
            </div>
          )}
        </div>
      )}
      
      {/* Error Message */}
      {displayData.error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-md">
          <p className="text-red-700 dark:text-red-400 text-sm">
            {displayData.error}
          </p>
        </div>
      )}
      
      {/* Console Logs */}
      {displayData.logs && displayData.logs.length > 0 && (
        <div className="border-t border-gray-200 dark:border-zinc-800 pt-4">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="flex items-center gap-2 text-sm text-gray-600 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-white transition-colors mb-2"
          >
            <FileText className="w-4 h-4" />
            <span>Console Output ({displayData.logs.length} lines)</span>
            {showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          
          <AnimatePresence>
            {showLogs && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div 
                  ref={logsContainerRef}
                  className="bg-gray-900 dark:bg-black rounded-md p-3 max-h-48 overflow-y-auto"
                >
                  <div className="space-y-1 font-mono text-xs">
                    {displayData.logs.map((log, index) => (
                      <div key={index} className="text-green-400">
                        {log}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      
      {/* Action Buttons */}
      {(displayData.status === 'error' || displayData.status === 'failed' || displayData.status === 'cancelled') && (
        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-zinc-800">
          {onDismiss && (
            <Button onClick={onDismiss} variant="ghost" size="sm">
              <X className="w-4 h-4 mr-1" />
              Dismiss
            </Button>
          )}
          {onRetry && (
            <Button onClick={onRetry} variant="primary" size="sm">
              <RotateCcw className="w-4 h-4 mr-1" />
              Retry
            </Button>
          )}
        </div>
      )}
    </Card>
  );
};