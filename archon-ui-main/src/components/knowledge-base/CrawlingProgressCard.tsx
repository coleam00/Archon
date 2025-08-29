import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChevronDown, 
  ChevronUp, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  Globe, 
  FileText,
  RotateCcw,
  X,
  Search,
  Download,
  Cpu,
  Database,
  Code,
  Zap,
  Square
} from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { CrawlProgressData } from '../../types/crawl';
import { useTerminalScroll } from '../../hooks/useTerminalScroll';
import { knowledgeBaseService } from '../../services/knowledgeBaseService';
import { useCrawlProgressPolling } from '../../hooks/usePolling';

interface CrawlingProgressCardProps {
  progressData: CrawlProgressData;
  onComplete: (data: CrawlProgressData) => void;
  onError: (error: string) => void;
  onProgress?: (data: CrawlProgressData) => void;
  onRetry?: () => void;
  onDismiss?: () => void;
  onStop?: () => void;
}

interface ProgressStep {
  id: string;
  label: string;
  icon: React.ReactNode;
  percentage: number;
  status: 'pending' | 'active' | 'completed' | 'error';
  message?: string;
}

export const CrawlingProgressCard: React.FC<CrawlingProgressCardProps> = ({
  progressData: initialProgressData,
  onComplete,
  onError,
  onProgress,
  onRetry,
  onDismiss,
  onStop
}) => {
  const [showDetailedProgress, setShowDetailedProgress] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [localProgressData, setLocalProgressData] = useState<CrawlProgressData>(initialProgressData);
  
  // Poll for progress updates for this specific card
  const { data: polledProgress } = useCrawlProgressPolling(
    localProgressData.status !== 'completed' && 
    localProgressData.status !== 'error' && 
    localProgressData.status !== 'cancelled' ? 
    localProgressData.progressId : null
  );
  
  // Update local progress data when polling returns new data
  useEffect(() => {
    if (polledProgress && polledProgress.progressId === localProgressData.progressId) {
      console.log(`📊 Card ${localProgressData.progressId}: Progress update`, {
        status: polledProgress.status,
        progress: polledProgress.progress
      });
      
      // Merge the polled data with existing data
      setLocalProgressData(prev => ({
        ...prev,
        ...polledProgress
      }));
      
      // Call onProgress callback if provided
      if (onProgress) {
        onProgress({ ...localProgressData, ...polledProgress });
      }
      
      // Handle completion
      if (polledProgress.status === 'completed' && onComplete) {
        console.log(`✅ Card ${localProgressData.progressId}: Crawl completed`);
        onComplete({ ...localProgressData, ...polledProgress });
      } else if ((polledProgress.status === 'error' || polledProgress.status === 'failed') && onError) {
        console.log(`❌ Card ${localProgressData.progressId}: Crawl failed`);
        onError(polledProgress.error || 'Unknown error');
      }
    }
  }, [polledProgress]); // Only depend on polledProgress changes
  
  // Use local progress data for display
  const progressData = localProgressData;
  
  // Use the terminal scroll hook for auto-scrolling logs
  const logsContainerRef = useTerminalScroll([progressData.logs], showLogs);

  // Handle stop crawl action
  const handleStopCrawl = async () => {
    console.log('🛑 Stop button clicked!');
    console.log('🛑 Progress data:', progressData);
    console.log('🛑 Progress ID:', progressData.progressId);
    console.log('🛑 Is stopping:', isStopping);
    console.log('🛑 onStop callback:', onStop);
    
    if (!progressData.progressId || isStopping) {
      console.log('🛑 Stopping early - no progress ID or already stopping');
      return;
    }
    
    try {
      setIsStopping(true);
      console.log('🛑 Stopping crawl with progress ID:', progressData.progressId);
      
      // Optimistic UI update - immediately show stopping status
      progressData.status = 'stopping';
      
      // Call the onStop callback if provided - this will handle localStorage and API call
      if (onStop) {
        console.log('🛑 Calling onStop callback');
        onStop();
      }
    } catch (error) {
      console.error('Failed to stop crawl:', error);
      // Revert optimistic update on error
      progressData.status = progressData.status === 'stopping' ? 'processing' : progressData.status;
    } finally {
      setIsStopping(false);
    }
  };

  // Calculate individual progress steps based on current status and percentage
  const getProgressSteps = (): ProgressStep[] => {
    // Check if this is an upload operation
    const isUpload = progressData.uploadType === 'document';
    
    const steps: ProgressStep[] = isUpload ? [
      {
        id: 'reading',
        label: 'Reading File',
        icon: <Download className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'extracting',
        label: 'Text Extraction',
        icon: <FileText className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'chunking',
        label: 'Content Chunking',
        icon: <Cpu className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'creating_source',
        label: 'Creating Source',
        icon: <Database className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'summarizing',
        label: 'AI Summary',
        icon: <Search className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'storing',
        label: 'Storing Chunks',
        icon: <Database className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      }
    ] : [
      {
        id: 'analyzing',
        label: 'URL Analysis',
        icon: <Search className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'crawling',
        label: 'Web Crawling',
        icon: <Globe className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'processing',
        label: 'Content Processing',
        icon: <Cpu className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'source_creation',
        label: 'Source Creation',
        icon: <FileText className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'document_storage',
        label: 'Document Storage',
        icon: <Database className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'code_storage',
        label: 'Code Examples',
        icon: <Code className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      },
      {
        id: 'finalization',
        label: 'Finalization',
        icon: <Zap className="w-4 h-4" />,
        percentage: 0,
        status: 'pending'
      }
    ];

    // Map current status directly to step progress
    const currentStatus = progressData.status;
    const currentPercentage = progressData.percentage || 0;

    // Normalize status to handle backend/frontend naming differences
    const normalizedStatus = currentStatus === 'code_extraction' ? 'code_storage' : currentStatus;

    // Define step order for completion tracking
    const stepOrder = isUpload 
      ? ['reading', 'extracting', 'chunking', 'creating_source', 'summarizing', 'storing']
      : ['analyzing', 'crawling', 'processing', 'source_creation', 'document_storage', 'code_storage', 'finalization'];
    
    // Update step progress based on current status
    steps.forEach((step) => {
      const stepIndex = stepOrder.indexOf(step.id);
      const currentStepIndex = stepOrder.indexOf(normalizedStatus);
      
      if (currentStatus === 'error') {
        if (stepIndex <= currentStepIndex) {
          step.status = stepIndex === currentStepIndex ? 'error' : 'completed';
          step.percentage = stepIndex === currentStepIndex ? currentPercentage : 100;
        } else {
          step.status = 'pending';
          step.percentage = 0;
        }
      } else if (currentStatus === 'completed') {
        step.status = 'completed';
        step.percentage = 100;
      } else if (step.id === normalizedStatus) {
        // This is the active step
        step.status = 'active';
        // Calculate phase-specific percentage based on overall progress
        // Each phase has a range in the overall progress:
        // analyzing: 0-5%, crawling: 5-20%, processing/source_creation: 10-20%, 
        // document_storage: 20-85%, code_storage: 85-95%, finalization: 95-100%
        const phaseRanges = {
          'analyzing': { start: 0, end: 5 },
          'crawling': { start: 5, end: 20 },
          'processing': { start: 10, end: 15 },
          'source_creation': { start: 15, end: 20 },
          'document_storage': { start: 20, end: 85 },
          'code_storage': { start: 85, end: 95 },
          'code_extraction': { start: 85, end: 95 },
          'finalization': { start: 95, end: 100 }
        };
        
        const range = phaseRanges[step.id as keyof typeof phaseRanges];
        if (range && currentPercentage >= range.start) {
          // Calculate percentage within this phase
          const phaseProgress = ((currentPercentage - range.start) / (range.end - range.start)) * 100;
          step.percentage = Math.min(Math.round(phaseProgress), 100);
        } else {
          step.percentage = currentPercentage;
        }
      } else if (stepIndex < currentStepIndex) {
        // Previous steps are completed
        step.status = 'completed';
        step.percentage = 100;
      } else {
        // Future steps are pending
        step.status = 'pending';
        step.percentage = 0;
      }

      // Set specific messages based on current status
      if (step.status === 'active') {
        // Prioritize backend-provided step message
        if (progressData.stepMessage) {
          step.message = progressData.stepMessage;
        } else if (progressData.log) {
          // Fall back to log message if no stepMessage
          step.message = progressData.log;
        } else {
          // Only use hardcoded fallback messages if no backend info provided
          if (isUpload) {
            switch (step.id) {
              case 'reading':
                step.message = `Reading ${progressData.fileName || 'file'}...`;
                break;
              case 'extracting':
                step.message = `Extracting text from ${progressData.fileType || 'document'}...`;
                break;
              case 'chunking':
                step.message = 'Breaking into chunks...';
                break;
              case 'creating_source':
                step.message = 'Creating source entry...';
                break;
              case 'summarizing':
                step.message = 'Generating AI summary...';
                break;
              case 'storing':
                step.message = 'Storing in database...';
                break;
            }
          } else {
            switch (step.id) {
              case 'analyzing':
                step.message = 'Detecting URL type...';
                break;
              case 'crawling':
                step.message = `${progressData.processedPages || 0} of ${progressData.totalPages || 0} pages`;
                break;
              case 'processing':
                step.message = 'Chunking content...';
                break;
              case 'source_creation':
                step.message = 'Creating source records...';
                break;
              case 'document_storage':
                if (progressData.completedBatches !== undefined && progressData.totalBatches) {
                  step.message = `Batch ${progressData.completedBatches}/${progressData.totalBatches} - Saving to database...`;
                } else {
                  step.message = 'Saving to database...';
                }
                break;
              case 'code_storage':
                step.message = 'Extracting code blocks...';
                break;
              case 'finalization':
                step.message = 'Completing crawl...';
                break;
            }
          }
        }
      } else if (step.status === 'completed' && step.percentage === 100 && currentPercentage < 95) {
        // Add message for completed steps when overall progress is still ongoing
        const isTextFile = progressData.currentUrl && 
          (progressData.currentUrl.endsWith('.txt') || progressData.currentUrl.endsWith('.md'));
        
        switch (step.id) {
          case 'crawling':
            step.message = isTextFile ? 'Text file fetched, processing content...' : 'Crawling complete, processing...';
            break;
          case 'analyzing':
            step.message = 'Analysis complete';
            break;
          case 'processing':
            step.message = 'Processing complete';
            break;
          case 'source_creation':
            step.message = 'Source created';
            break;
        }
      }
    });

    return steps;
  };

  const progressSteps = getProgressSteps();
  const overallStatus = progressData.status;

  const getOverallStatusDisplay = () => {
    const isUpload = progressData.uploadType === 'document';
    
    switch (overallStatus) {
      case 'starting':
        return {
          text: isUpload ? 'Starting upload...' : 'Starting crawl...',
          color: 'blue' as const,
          icon: <Clock className="w-4 h-4" />
        };
      case 'completed':
        return {
          text: isUpload ? 'Upload completed!' : 'Crawling completed!',
          color: 'green' as const,
          icon: <CheckCircle className="w-4 h-4" />
        };
      case 'error':
        return {
          text: isUpload ? 'Upload failed' : 'Crawling failed',
          color: 'pink' as const,
          icon: <AlertTriangle className="w-4 h-4" />
        };
      case 'stale':
        return {
          text: isUpload ? 'Upload appears stuck' : 'Crawl appears stuck',
          color: 'pink' as const,
          icon: <AlertTriangle className="w-4 h-4" />
        };
      case 'reading':
        return {
          text: 'Reading file...',
          color: 'blue' as const,
          icon: <Download className="w-4 h-4" />
        };
      case 'extracting':
        return {
          text: 'Extracting text...',
          color: 'blue' as const,
          icon: <FileText className="w-4 h-4" />
        };
      case 'chunking':
        return {
          text: 'Processing content...',
          color: 'blue' as const,
          icon: <Cpu className="w-4 h-4" />
        };
      case 'creating_source':
        return {
          text: 'Creating source...',
          color: 'blue' as const,
          icon: <Database className="w-4 h-4" />
        };
      case 'summarizing':
        return {
          text: 'Generating summary...',
          color: 'blue' as const,
          icon: <Search className="w-4 h-4" />
        };
      case 'storing':
        return {
          text: 'Storing chunks...',
          color: 'blue' as const,
          icon: <Database className="w-4 h-4" />
        };
      case 'source_creation':
        return {
          text: 'Creating source records...',
          color: 'blue' as const,
          icon: <FileText className="w-4 h-4" />
        };
      case 'document_storage':
        return {
          text: progressData.completedBatches !== undefined && progressData.totalBatches 
            ? `Document Storage: ${progressData.completedBatches}/${progressData.totalBatches} batches`
            : 'Storing documents...',
          color: 'blue' as const,
          icon: <Database className="w-4 h-4" />
        };
      case 'code_storage':
      case 'code_extraction':
        return {
          text: 'Processing code examples...',
          color: 'blue' as const,
          icon: <Code className="w-4 h-4" />
        };
      case 'finalization':
        return {
          text: 'Finalizing...',
          color: 'blue' as const,
          icon: <Zap className="w-4 h-4" />
        };
      case 'cancelled':
        return {
          text: isUpload ? 'Upload cancelled' : 'Crawling cancelled',
          color: 'pink' as const,
          icon: <Square className="w-4 h-4" />
        };
      case 'stopping':
        return {
          text: isUpload ? 'Stopping upload...' : 'Stopping crawl...',
          color: 'pink' as const,
          icon: <Square className="w-4 h-4" />
        };
      default:
        const activeStep = progressSteps.find(step => step.status === 'active');
        return {
          text: activeStep ? activeStep.label : 'Processing...',
          color: 'blue' as const,
          icon: activeStep ? activeStep.icon : <Clock className="w-4 h-4" />
        };
    }
  };

  const status = getOverallStatusDisplay();

  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  const getStepStatusColor = (stepStatus: string, isProcessingContinuing: boolean = false) => {
    switch (stepStatus) {
      case 'completed':
        return isProcessingContinuing 
          ? 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-500/10 animate-pulse'
          : 'text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-500/10';
      case 'active':
        return 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/10';
      case 'error':
        return 'text-pink-600 dark:text-pink-400 bg-pink-100 dark:bg-pink-500/10';
      default:
        return 'text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-500/10';
    }
  };

  return (
    <Card accentColor={status.color} className="relative" data-testid="crawling-progress-card">
      {/* Status Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`p-2 rounded-md ${
          status.color === 'blue' ? 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400' :
          status.color === 'green' ? 'bg-green-100 dark:bg-green-500/10 text-green-600 dark:text-green-400' :
          status.color === 'pink' ? 'bg-pink-100 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400' :
          'bg-gray-100 dark:bg-gray-500/10 text-gray-600 dark:text-gray-400'
        }`}>
          {status.icon}
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <h3 className="font-medium text-gray-800 dark:text-white" data-testid="crawling-progress-title">
            {status.text}
          </h3>
          {progressData.currentUrl && (
            <p className="text-sm text-gray-500 dark:text-zinc-400 truncate">
              {progressData.currentUrl}
            </p>
          )}
        </div>

        {/* Stop Button - only show for active crawls */}
        {progressData.status !== 'completed' && 
         progressData.status !== 'error' && 
         progressData.status !== 'cancelled' && 
         onStop && (
          <div className="flex-shrink-0 ml-2">
            <motion.button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('🛑 Button click event triggered');
                handleStopCrawl();
              }}
              disabled={isStopping}
              data-testid="crawling-progress-stop"
              className={`
                relative rounded-full border-2 transition-all duration-300 p-2
                border-red-400 hover:border-red-300
                ${isStopping ? 
                  'bg-gray-100 dark:bg-gray-800 opacity-50 cursor-not-allowed' : 
                  'bg-gradient-to-b from-gray-900 to-black cursor-pointer'
                }
                shadow-[0_0_8px_rgba(239,68,68,0.6)] hover:shadow-[0_0_12px_rgba(239,68,68,0.8)]
              `}
              whileHover={{ scale: isStopping ? 1 : 1.05 }}
              whileTap={{ scale: isStopping ? 1 : 0.95 }}
              title={isStopping ? "Stopping..." : "Stop Crawl"}
            >
              {/* Simplified glow - no overflow issues */}
              <motion.div
                className="absolute inset-0 rounded-full border-2 border-red-400"
                animate={{
                  opacity: isStopping ? 0 : [0.4, 0.8, 0.4],
                  scale: isStopping ? 1 : [1, 1.1, 1]
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              />

              {/* Stop icon with simpler glow */}
              <motion.div
                className="relative z-10"
                animate={{
                  filter: isStopping ? 'none' : [
                    'drop-shadow(0 0 4px rgb(239,68,68))',
                    'drop-shadow(0 0 8px rgb(239,68,68))',
                    'drop-shadow(0 0 4px rgb(239,68,68))'
                  ]
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              >
                <Square 
                  className={`w-4 h-4 ${
                    isStopping ? 'text-gray-600' : 'text-white'
                  }`} 
                  fill="currentColor"
                />
              </motion.div>
            </motion.button>
          </div>
        )}

      </div>

      {/* Main Progress Bar */}
      {progressData.status !== 'completed' && progressData.status !== 'error' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Overall Progress
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {Math.round(Math.max(0, Math.min(100, progressData.percentage || 0)))}%
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2" data-testid="crawling-progress-bar">
            <motion.div
              className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-blue-600"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(0, Math.min(100, progressData.percentage || 0))}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
        </div>
      )}

      {/* Show parallel workers info when available */}
      {progressData.parallelWorkers && progressData.parallelWorkers > 1 && 
       progressData.status === 'document_storage' && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-md">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="text-sm font-medium text-blue-700 dark:text-blue-400">
              Processing with {progressData.parallelWorkers} parallel workers
            </span>
          </div>
          {progressData.totalJobs && (
            <div className="mt-1 text-xs text-blue-600 dark:text-blue-400/80">
              Total batches to process: {progressData.totalJobs}
            </div>
          )}
        </div>
      )}

      {/* Show info when crawling is complete but processing continues */}
      {progressData.status === 'document_storage' && progressData.percentage < 30 && (
        <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-md">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-pulse" />
            <span className="text-sm text-blue-700 dark:text-blue-400">
              Content fetched successfully. Processing and storing documents...
            </span>
          </div>
        </div>
      )}

      {/* Detailed Progress Toggle */}
      {progressData.status !== 'completed' && progressData.status !== 'error' && (
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

      {/* Multi-Progress Bars */}
      <AnimatePresence>
        {showDetailedProgress && progressData.status !== 'completed' && progressData.status !== 'error' && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden mb-4"
          >
            <div className="space-y-3 p-3 bg-gray-50 dark:bg-zinc-900/50 rounded-md" data-testid="crawling-progress-details">
              {/* Always show progress steps */}
              {progressSteps.map((step) => (
                <div key={step.id}>
                  <div className="flex items-center gap-3">
                    <div className={`p-1.5 rounded-md ${getStepStatusColor(
                      step.status, 
                      false // Never pulse for step icons - only the active step should animate via rotation
                    )}`}>
                      {step.status === 'active' && progressData.status !== 'completed' ? (
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
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {step.label}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {Math.round(step.percentage)}%
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-1.5">
                        <motion.div
                          className={`h-1.5 rounded-full ${
                            step.status === 'completed' ? 'bg-green-500' :
                            step.status === 'active' ? 'bg-blue-500' :
                            step.status === 'error' ? 'bg-pink-500' :
                            'bg-gray-300 dark:bg-gray-600'
                          }`}
                          initial={{ width: 0 }}
                          animate={{ width: `${step.percentage}%` }}
                          transition={{ duration: 0.5, ease: 'easeOut' }}
                        />
                      </div>
                      {step.message && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                          {step.message}
                        </p>
                      )}
                    </div>
                  </div>
                  
                  {/* Show simplified batch progress for document_storage step */}
                  {step.id === 'document_storage' && (step.status === 'active' || step.status === 'completed') && 
                   progressData.total_batches && progressData.total_batches > 0 && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="mt-3 ml-8 space-y-3 border-l-2 border-gray-200 dark:border-zinc-700 pl-4"
                    >
                      {/* Batch progress info */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                            Batch Progress
                          </span>
                          <div className="flex items-center gap-2">
                            {progressData.active_workers && progressData.active_workers > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-500/10 text-blue-800 dark:text-blue-400">
                                <Cpu className="w-3 h-3 mr-1" />
                                {progressData.active_workers} {progressData.active_workers === 1 ? 'worker' : 'workers'}
                              </span>
                            )}
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {progressData.completed_batches || 0}/{progressData.total_batches || 0}
                            </span>
                          </div>
                        </div>
                        
                        {/* Single batch progress bar */}
                        <div className="w-full bg-gray-200 dark:bg-zinc-700 rounded-full h-2">
                          <motion.div
                            className="h-2 rounded-full bg-blue-500 dark:bg-blue-400"
                            initial={{ width: 0 }}
                            animate={{ 
                              width: `${Math.round(((progressData.completed_batches || 0) / (progressData.total_batches || 1)) * 100)}%` 
                            }}
                            transition={{ duration: 0.5, ease: 'easeOut' }}
                          />
                        </div>
                        
                        {/* Current batch details */}
                        {progressData.current_batch && progressData.current_batch > 0 && (
                          <div className="text-xs text-gray-600 dark:text-gray-400">
                            <span className="font-medium">Processing batch {progressData.current_batch}:</span>
                            {progressData.total_chunks_in_batch && progressData.total_chunks_in_batch > 0 && (
                              <span className="ml-2">
                                {progressData.chunks_in_batch || 0}/{progressData.total_chunks_in_batch} chunks processed
                              </span>
                            )}
                          </div>
                        )}
                        
                        {/* Status text */}
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Completed: {progressData.completed_batches || 0} batches
                          {progressData.current_batch && progressData.current_batch > 0 && 
                            progressData.current_batch <= (progressData.total_batches || 0) && (
                            <span> • In Progress: 1 batch</span>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>


      {/* Progress Details */}
      <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
        {progressData.uploadType === 'document' ? (
          // Upload-specific details
          <>
            {progressData.fileName && (
              <div className="col-span-2">
                <span className="text-gray-500 dark:text-zinc-400">File:</span>
                <span className="ml-2 font-medium text-gray-800 dark:text-white">
                  {progressData.fileName}
                </span>
              </div>
            )}
            {progressData.status === 'completed' && (
              <>
                {progressData.chunksStored && (
                  <div>
                    <span className="text-gray-500 dark:text-zinc-400">Chunks:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white">
                      {formatNumber(progressData.chunksStored)} chunks stored
                    </span>
                  </div>
                )}
                {progressData.wordCount && (
                  <div>
                    <span className="text-gray-500 dark:text-zinc-400">Words:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white">
                      {formatNumber(progressData.wordCount)} words processed
                    </span>
                  </div>
                )}
                {progressData.sourceId && (
                  <div className="col-span-2">
                    <span className="text-gray-500 dark:text-zinc-400">Source ID:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white font-mono text-xs">
                      {progressData.sourceId}
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          // Crawl-specific details
          <>
            {progressData.totalPages && progressData.processedPages !== undefined && (
              <div>
                <span className="text-gray-500 dark:text-zinc-400">Pages:</span>
                <span className="ml-2 font-medium text-gray-800 dark:text-white">
                  {progressData.processedPages} of {progressData.totalPages} pages processed
                </span>
              </div>
            )}
            
            {progressData.status === 'completed' && (
              <>
                {progressData.chunksStored && (
                  <div>
                    <span className="text-gray-500 dark:text-zinc-400">Chunks:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white">
                      {formatNumber(progressData.chunksStored)} chunks stored
                    </span>
                  </div>
                )}
                {progressData.wordCount && (
                  <div>
                    <span className="text-gray-500 dark:text-zinc-400">Words:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white">
                      {formatNumber(progressData.wordCount)} words processed
                    </span>
                  </div>
                )}
                {progressData.duration && (
                  <div className="col-span-2">
                    <span className="text-gray-500 dark:text-zinc-400">Duration:</span>
                    <span className="ml-2 font-medium text-gray-800 dark:text-white">
                      {progressData.duration}
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Error Message */}
      {progressData.status === 'error' && progressData.error && (
        <div className="mb-4 p-3 bg-pink-50 dark:bg-pink-500/10 border border-pink-200 dark:border-pink-500/20 rounded-md">
          <p className="text-pink-700 dark:text-pink-400 text-sm">
            {progressData.error}
          </p>
        </div>
      )}

      {/* Console Logs */}
      {progressData.logs && progressData.logs.length > 0 && (
        <div className="border-t border-gray-200 dark:border-zinc-800 pt-4">
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="flex items-center gap-2 text-sm text-gray-600 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-white transition-colors mb-2"
          >
            <FileText className="w-4 h-4" />
            <span>View Console Output</span>
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
                  className="bg-gray-900 dark:bg-black rounded-md p-3 max-h-32 overflow-y-auto"
                >
                  <div className="space-y-1 font-mono text-xs">
                    {progressData.logs.map((log, index) => (
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
      {(progressData.status === 'error' || progressData.status === 'cancelled' || progressData.status === 'stale') && (onRetry || onDismiss) && (
        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-zinc-800">
          {onDismiss && (
            <Button 
              onClick={onDismiss}
              variant="ghost" 
              className="text-sm"
            >
              <X className="w-4 h-4 mr-2" />
              Dismiss
            </Button>
          )}
          {onRetry && progressData.status !== 'stale' && (
            <Button 
              onClick={onRetry}
              variant="primary" 
              accentColor="blue"
              className="text-sm"
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}; 