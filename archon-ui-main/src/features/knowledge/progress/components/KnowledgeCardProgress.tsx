/**
 * Knowledge Card Progress Component
 * Displays inline crawl progress for knowledge items
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Code, FileText, Link, Loader2 } from "lucide-react";
import { cn } from "../../../ui/primitives/styles";
import { useOperationProgress } from "../hooks";
import type { ProgressResponse } from "../types/progress";

interface KnowledgeCardProgressProps {
  progressId: string | null;
  isActive: boolean;
}

export const KnowledgeCardProgress: React.FC<KnowledgeCardProgressProps> = ({ progressId, isActive }) => {
  const { data: progress, isLoading } = useOperationProgress(progressId, {
    pollingInterval: 1000,
  });

  // Type assertion to help TypeScript understand the progress structure
  const typedProgress = progress as ProgressResponse | undefined;

  // Hide if no progress or completed/failed
  if (!isActive || !typedProgress || isLoading) {
    return null;
  }

  const getStatusIcon = () => {
    switch (typedProgress.status) {
      case "completed":
        return <CheckCircle2 className="w-3 h-3" />;
      case "failed":
      case "error":
        return <AlertCircle className="w-3 h-3" />;
      default:
        return <Loader2 className="w-3 h-3 animate-spin" />;
    }
  };

  const getStatusColor = () => {
    switch (typedProgress.status) {
      case "completed":
        return "text-green-500 bg-green-500/10 border-green-500/20";
      case "failed":
      case "error":
        return "text-red-500 bg-red-500/10 border-red-500/20";
      case "cancelled":
      case "stopping":
        return "text-yellow-500 bg-yellow-500/10 border-yellow-500/20";
      default:
        return "text-cyan-500 bg-cyan-500/10 border-cyan-500/20";
    }
  };

  // Use the main progress field from backend (0-100)
  const progressPercentage = typedProgress.progress || 0;
  // Use current_step if available, otherwise format the status
  const currentStep =
    typedProgress.current_step ||
    typedProgress.message ||
    typedProgress.status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const stats = typedProgress.stats || typedProgress.progress_data;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.3 }}
        className="border-t border-white/10 bg-black/20"
      >
        <div className="p-3 space-y-2">
          {/* Status line */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={cn("px-2 py-0.5 text-xs rounded-full border flex items-center gap-1", getStatusColor())}>
                {getStatusIcon()}
                <span>{currentStep}</span>
              </span>
            </div>
            <span className="text-xs text-gray-500">{Math.round(progressPercentage)}%</span>
          </div>

          {/* Progress bar */}
          <div className="relative h-1.5 bg-black/40 rounded-full overflow-hidden">
            <motion.div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-cyan-500 to-blue-600"
              initial={{ width: 0 }}
              animate={{ width: `${progressPercentage}%` }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
          </div>

          {/* Stats */}
          {stats && (
            <div className="flex items-center gap-4 text-xs text-gray-500">
              {"pages_crawled" in stats && stats.pages_crawled !== undefined && (
                <div className="flex items-center gap-1">
                  <Link className="w-3 h-3" />
                  <span>{stats.pages_crawled} pages</span>
                </div>
              )}
              {"documents_processed" in stats && stats.documents_processed !== undefined && (
                <div className="flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  <span>{stats.documents_processed} docs</span>
                </div>
              )}
              {"documents_created" in stats && stats.documents_created !== undefined && (
                <div className="flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  <span>{stats.documents_created} docs</span>
                </div>
              )}
              {"code_examples_found" in stats &&
                stats.code_examples_found !== undefined &&
                stats.code_examples_found > 0 && (
                  <div className="flex items-center gap-1">
                    <Code className="w-3 h-3 text-green-500" />
                    <span>{stats.code_examples_found} examples</span>
                  </div>
                )}
            </div>
          )}

          {/* Error message */}
          {typedProgress.status === "failed" && typedProgress.error_message && (
            <div className="text-xs text-red-400 mt-2">{typedProgress.error_message}</div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
