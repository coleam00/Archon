/**
 * Knowledge Card Progress Component
 * Displays inline crawl progress for knowledge items
 * Simplified to directly use ActiveOperation data like CrawlingProgress does
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Code, FileText, Link, Loader2 } from "lucide-react";
import { cn } from "../../ui/primitives/styles";
import type { ActiveOperation } from "../types/progress";

interface KnowledgeCardProgressProps {
  operation: ActiveOperation;
}

export const KnowledgeCardProgress: React.FC<KnowledgeCardProgressProps> = ({ operation }) => {
  // Direct progress field from backend (0-100) - same as CrawlingProgress
  const progressPercentage = typeof operation.progress === "number" ? Math.round(operation.progress) : 0;

  // Check if operation is active - same logic as CrawlingProgress
  const isActive = [
    "crawling",
    "processing",
    "in_progress",
    "starting",
    "initializing",
    "analyzing",
    "source_creation",
    "document_storage",
    "code_extraction",
  ].includes(operation.status);

  // Don't show if not active
  if (!isActive) {
    return null;
  }

  const getStatusIcon = () => {
    switch (operation.status) {
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
    switch (operation.status) {
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

  // Format the status text
  const currentStep = operation.message || operation.status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const stats = operation.stats || operation.progress_data;

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

          {/* Stats - simplified to match CrawlingProgress */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            {(operation.pages_crawled !== undefined || stats?.pages_crawled !== undefined) && (
              <div className="flex items-center gap-1">
                <Link className="w-3 h-3" />
                <span>{operation.pages_crawled || stats?.pages_crawled || 0} pages</span>
              </div>
            )}
            {(operation.documents_created !== undefined ||
              (stats && "documents_created" in stats && stats.documents_created !== undefined)) && (
              <div className="flex items-center gap-1">
                <FileText className="w-3 h-3" />
                <span>
                  {operation.documents_created || (stats && "documents_created" in stats ? stats.documents_created : 0)}{" "}
                  docs
                </span>
              </div>
            )}
            {operation.code_blocks_found !== undefined && (
              <div className="flex items-center gap-1">
                <Code className="w-3 h-3 text-green-500" />
                <span>{operation.code_blocks_found} examples</span>
              </div>
            )}
          </div>

          {/* Error message */}
          {operation.status === "error" && operation.message && (
            <div className="text-xs text-red-400 mt-2">{operation.message}</div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
