/**
 * Crawling Progress Component
 * Shows active crawling operations with progress tracking
 */

// Removed relative started time display to avoid misleading UX
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle, Globe, Loader2, StopCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { useStopCrawl } from "../../knowledge/hooks";
import { Button } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { useCrawlProgressPolling } from "../hooks";
import type { ActiveOperation } from "../types/progress";

interface CrawlingProgressProps {
  onSwitchToBrowse: () => void;
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: { duration: 0.3 },
  },
};

export const CrawlingProgress: React.FC<CrawlingProgressProps> = ({ onSwitchToBrowse }) => {
  const { activeOperations, isLoading } = useCrawlProgressPolling();
  const stopMutation = useStopCrawl();
  const [stoppingId, setStoppingId] = useState<string | null>(null);

  const handleStop = async (progressId: string) => {
    try {
      setStoppingId(progressId);
      await stopMutation.mutateAsync(progressId);
      // Toast is now handled by the useStopCrawl hook
    } catch (error) {
      // Error toast is now handled by the useStopCrawl hook
      console.error("Stop crawl failed:", { progressId, error });
    } finally {
      setStoppingId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="w-4 h-4 text-green-400" />;
      case "failed":
      case "error":
        return <XCircle className="w-4 h-4 text-red-400" />;
      case "stopped":
      case "cancelled":
        return <StopCircle className="w-4 h-4 text-yellow-400" />;
      default:
        return <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "text-green-400 bg-green-500/10 border-green-500/20";
      case "failed":
      case "error":
        return "text-red-400 bg-red-500/10 border-red-500/20";
      case "stopped":
      case "cancelled":
        return "text-yellow-400 bg-yellow-500/10 border-yellow-500/20";
      default:
        return "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";
    }
  };

  const getProgressPercentage = (operation: ActiveOperation): number => {
    // Direct progress field from backend (0-100) - this is the main field
    if (typeof operation.progress === "number") {
      return Math.round(operation.progress);
    }

    return 0;
  };

  if (isLoading && activeOperations.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading crawling operations...</p>
        </div>
      </div>
    );
  }

  if (activeOperations.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center max-w-md">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-cyan-500/10 mb-4">
            <Globe className="w-6 h-6 text-cyan-400" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No Active Operations</h3>
          <p className="text-gray-400 mb-4">
            Start crawling websites or uploading documents to expand your knowledge base.
          </p>
          <Button onClick={onSwitchToBrowse} variant="outline">
            Browse Knowledge Base
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AnimatePresence mode="popLayout">
        {activeOperations.map((operation) => {
          const progress = getProgressPercentage(operation);
          const isActive = [
            "crawling",
            "processing",
            "in_progress",
            "starting",
            "initializing",
            "analyzing",
            "storing",
            "source_creation",
            "document_storage",
            "code_extraction",
          ].includes(operation.status);

          return (
            <motion.div
              key={operation.operation_id}
              layout
              variants={itemVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <div
                className={cn(
                  "overflow-hidden transition-all duration-300 rounded-lg border",
                  "bg-black/40 backdrop-blur-sm border-white/10",
                  isActive && "border-cyan-500/30 shadow-[0_0_20px_rgba(6,182,212,0.15)]",
                )}
              >
                <div className="p-4 border-b border-white/10">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg font-semibold text-white/90 flex items-center gap-2">
                        {getStatusIcon(operation.status)}
                        <span className="truncate">
                          {operation.message || operation.current_url || "Processing..."}
                        </span>
                      </h3>
                      <div className="flex items-center gap-2 mt-2">
                        <span className={cn("px-2 py-1 text-xs rounded", getStatusColor(operation.status))}>
                          {operation.status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                        </span>
                        {operation.operation_type && (
                          <span className="px-2 py-1 text-xs border border-white/20 rounded bg-black/20">
                            {operation.operation_type === "crawl"
                              ? "Web Crawl"
                              : operation.operation_type === "upload"
                                ? "Document Upload"
                                : operation.operation_type}
                          </span>
                        )}
                        {/* Removed relative start time; it can be misleading for recrawls or resumed ops */}
                      </div>
                    </div>

                    {isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleStop(operation.operation_id)}
                        disabled={stoppingId === operation.operation_id}
                        className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      >
                        {stoppingId === operation.operation_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <StopCircle className="w-4 h-4" />
                        )}
                        <span className="ml-2">Stop</span>
                      </Button>
                    )}
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  {/* Progress Bar */}
                  {isActive && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">Progress</span>
                        <span className="text-cyan-400 font-medium">{progress}%</span>
                      </div>
                      <div className="h-2 bg-black/30 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-cyan-500 transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Statistics */}
                  <div className="grid grid-cols-3 gap-4 pt-2">
                    {(operation.pages_crawled !== undefined || operation.stats?.pages_crawled !== undefined) && (
                      <div className="text-center">
                        <div className="text-2xl font-bold text-cyan-400">
                          {operation.pages_crawled || operation.stats?.pages_crawled || 0}
                        </div>
                        <div className="text-xs text-gray-500">Pages Crawled</div>
                      </div>
                    )}
                    {(operation.documents_created !== undefined ||
                      operation.stats?.documents_created !== undefined) && (
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-400">
                          {operation.documents_created || operation.stats?.documents_created || 0}
                        </div>
                        <div className="text-xs text-gray-500">Documents</div>
                      </div>
                    )}
                    {(operation.code_blocks_found !== undefined || operation.stats?.errors !== undefined) && (
                      <div className="text-center">
                        <div className="text-2xl font-bold text-yellow-400">
                          {operation.code_blocks_found || operation.stats?.errors || 0}
                        </div>
                        <div className="text-xs text-gray-500">
                          {operation.code_blocks_found !== undefined ? "Code Blocks" : "Errors"}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Current Action or Operation Type Info */}
                  {(operation.current_url || operation.operation_type) && (
                    <div className="pt-2 border-t border-white/10">
                      {operation.current_url && (
                        <p className="text-sm text-gray-400 truncate">
                          <span className="text-gray-500">URL:</span> {operation.current_url}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Error Message */}
                  {operation.status === "error" && operation.message && (
                    <div className="flex items-start gap-2 p-3 bg-red-500/10 rounded-lg border border-red-500/20">
                      <AlertCircle className="w-4 h-4 text-red-400 mt-0.5" />
                      <p className="text-sm text-red-400">{operation.message}</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
