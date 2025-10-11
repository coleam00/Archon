/**
 * Knowledge List Component
 * Displays knowledge items in grid or table view
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ActiveOperation } from "../../progress/types";
import { Button } from "../../ui/primitives";
import type { KnowledgeItem } from "../types";
import { KnowledgeCard } from "./KnowledgeCard";
import { KnowledgeTable } from "./KnowledgeTable";

interface KnowledgeListProps {
  items: KnowledgeItem[];
  viewMode: "grid" | "table";
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  onViewDocument: (sourceId: string) => void;
  onViewCodeExamples?: (sourceId: string) => void;
  onDeleteSuccess: () => void;
  activeOperations?: ActiveOperation[];
  onRefreshStarted?: (progressId: string) => void;
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

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
    },
  },
};

export const KnowledgeList: React.FC<KnowledgeListProps> = ({
  items,
  viewMode,
  isLoading,
  error,
  onRetry,
  onViewDocument,
  onViewCodeExamples,
  onDeleteSuccess,
  activeOperations = [],
  onRefreshStarted,
}) => {
  // Helper to check if an item is being recrawled
  const getActiveOperationForItem = (item: KnowledgeItem): ActiveOperation | undefined => {
    // First try to match by source_id (most reliable for refresh operations)
    const matchBySourceId = activeOperations.find((op) => op.source_id === item.source_id);
    if (matchBySourceId) {
      return matchBySourceId;
    }

    // Fallback: Check if any active operation is for this item's URL
    const itemUrl = item.metadata?.original_url || item.url;
    return activeOperations.find((op) => {
      // Check various URL fields in the operation
      return (
        op.url === itemUrl ||
        op.current_url === itemUrl ||
        op.message?.includes(itemUrl) ||
        (op.operation_type === "crawl" && op.message?.includes(item.title))
      );
    });
  };
  // Loading state
  if (isLoading && items.length === 0) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={itemVariants}
        className="flex items-center justify-center py-12"
      >
        <div className="text-center" aria-live="polite" aria-busy="true">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading knowledge base...</p>
        </div>
      </motion.div>
    );
  }

  // Error state
  if (error) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={itemVariants}
        className="flex items-center justify-center py-12"
      >
        <div className="text-center max-w-md" role="alert">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-500/10 dark:bg-red-500/10 mb-4">
            <AlertCircle className="w-6 h-6 text-red-400" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Failed to Load Knowledge Base</h3>
          <p className="text-gray-400 mb-4">{error.message}</p>
          <Button onClick={onRetry} variant="outline">
            Try Again
          </Button>
        </div>
      </motion.div>
    );
  }

  // Empty state
  if (items.length === 0) {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={itemVariants}
        className="flex items-center justify-center py-12"
      >
        <div className="text-center max-w-md">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-cyan-500/10 dark:bg-cyan-500/10 mb-4">
            <AlertCircle className="w-6 h-6 text-cyan-400" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No Knowledge Items</h3>
          <p className="text-gray-400">Start by adding documents or crawling websites to build your knowledge base.</p>
        </div>
      </motion.div>
    );
  }

  // Table view
  if (viewMode === "table") {
    return (
      <motion.div
        initial="hidden"
        animate="visible"
        variants={itemVariants}
        className="bg-black/30 rounded-lg border border-white/10 overflow-hidden"
      >
        <KnowledgeTable items={items} onViewDocument={onViewDocument} onDeleteSuccess={onDeleteSuccess} />
      </motion.div>
    );
  }

  // Grid view
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={containerVariants}
      className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
    >
      <AnimatePresence mode="popLayout">
        {items.map((item) => {
          const activeOperation = getActiveOperationForItem(item);
          return (
            <motion.div key={item.source_id} layout variants={itemVariants} exit="exit">
              <KnowledgeCard
                item={item}
                onViewDocument={() => onViewDocument(item.source_id)}
                onViewCodeExamples={onViewCodeExamples ? () => onViewCodeExamples(item.source_id) : undefined}
                onDeleteSuccess={onDeleteSuccess}
                activeOperation={activeOperation}
                onRefreshStarted={onRefreshStarted}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </motion.div>
  );
};
