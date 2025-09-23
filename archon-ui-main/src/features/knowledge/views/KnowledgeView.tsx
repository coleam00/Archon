/**
 * Main Knowledge Base View Component
 * Orchestrates the knowledge base UI using vertical slice architecture
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/features/shared/hooks/useToast";
import { CrawlingProgress } from "../../progress/components/CrawlingProgress";
import type { ActiveOperation } from "../../progress/types";
import { AddKnowledgeDialog } from "../components/AddKnowledgeDialog";
import { KnowledgeHeader } from "../components/KnowledgeHeader";
import { KnowledgeList } from "../components/KnowledgeList";
import { useKnowledgeSummaries } from "../hooks/useKnowledgeQueries";
import { KnowledgeInspector } from "../inspector/components/KnowledgeInspector";
import type { KnowledgeItem, KnowledgeItemsFilter } from "../types";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 300;

export const KnowledgeView = () => {
  // Local filter state (following Tasks/Projects pattern)
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"technical" | "business" | undefined>(undefined);

  // Debounce search query to avoid excessive API calls
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Compute current filter from local state
  const currentFilter: KnowledgeItemsFilter = useMemo(() => ({
    page: 1,
    per_page: PAGE_SIZE,
    ...(debouncedSearchQuery && { search: debouncedSearchQuery }),
    ...(typeFilter && { knowledge_type: typeFilter }),
  }), [debouncedSearchQuery, typeFilter]);

  // View state
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Dialog state
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [inspectorItem, setInspectorItem] = useState<KnowledgeItem | null>(null);
  const [inspectorInitialTab, setInspectorInitialTab] = useState<"documents" | "code">("documents");

  // Fetch knowledge summaries using current filter
  const { data, isLoading, error, refetch, setActiveCrawlIds, activeOperations } = useKnowledgeSummaries(currentFilter);

  const knowledgeItems = data?.items || [];
  const totalItems = data?.total || 0;
  const hasActiveOperations = activeOperations.length > 0;

  // Toast notifications
  const { showToast } = useToast();
  const previousOperations = useRef<ActiveOperation[]>([]);

  // Track crawl completions and errors for toast notifications
  useEffect(() => {
    // Find operations that just completed or failed
    const finishedOps = previousOperations.current.filter((prevOp) => {
      const currentOp = activeOperations.find((op) => op.operation_id === prevOp.operation_id);
      // Operation disappeared from active list - check its final status
      return (
        !currentOp &&
        ["crawling", "processing", "storing", "document_storage", "completed", "error", "failed"].includes(
          prevOp.status,
        )
      );
    });

    // Show toast for each finished operation
    finishedOps.forEach((op) => {
      // Check if it was an error or success
      if (op.status === "error" || op.status === "failed") {
        // Show error message with details
        const errorMessage = op.message || op.error || "Operation failed";
        showToast(`❌ ${errorMessage}`, "error", 7000);
      } else {
        // Show success message for any completed operation (not just "completed" status)
        const operationType = op.operation_type || "Operation";
        const successMessage = op.message || `${operationType} completed successfully`;
        showToast(`✅ ${successMessage}`, "success", 5000);
      }

      // Remove from active crawl IDs
      setActiveCrawlIds((prev) => prev.filter((id) => id !== op.operation_id));

      // Refetch summaries after any completion
      refetch();
    });

    // Update previous operations
    previousOperations.current = [...activeOperations];
  }, [activeOperations, showToast, refetch, setActiveCrawlIds]);

  const handleAddKnowledge = () => {
    setIsAddDialogOpen(true);
  };

  const handleViewDocument = (sourceId: string) => {
    // Find the item and open inspector to documents tab
    const item = knowledgeItems.find((k) => k.source_id === sourceId);
    if (item) {
      setInspectorInitialTab("documents");
      setInspectorItem(item);
    }
  };

  const handleViewCodeExamples = (sourceId: string) => {
    // Open the inspector to code examples tab
    const item = knowledgeItems.find((k) => k.source_id === sourceId);
    if (item) {
      setInspectorInitialTab("code");
      setInspectorItem(item);
    }
  };

  const handleDeleteSuccess = () => {
    // TanStack Query will automatically refetch
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <KnowledgeHeader
        totalItems={totalItems}
        isLoading={isLoading}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAddKnowledge={handleAddKnowledge}
      />

      {/* Main Content */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {/* Active Operations - Show at top when present */}
        {hasActiveOperations && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white/90">Active Operations ({activeOperations.length})</h3>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
                Live Updates
              </div>
            </div>
            <CrawlingProgress onSwitchToBrowse={() => {}} />
          </div>
        )}

        {/* Knowledge Items List */}
        <KnowledgeList
          items={knowledgeItems}
          viewMode={viewMode}
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
          onViewDocument={handleViewDocument}
          onViewCodeExamples={handleViewCodeExamples}
          onDeleteSuccess={handleDeleteSuccess}
          activeOperations={activeOperations}
          onRefreshStarted={(progressId) => {
            // Add the progress ID to track it
            setActiveCrawlIds((prev) => [...prev, progressId]);
          }}
        />
      </div>

      {/* Dialogs */}
      <AddKnowledgeDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        currentFilter={currentFilter}
        onSuccess={() => {
          setIsAddDialogOpen(false);
          refetch();
        }}
        onCrawlStarted={(progressId) => {
          // Add the progress ID to track it
          setActiveCrawlIds((prev) => [...prev, progressId]);
        }}
      />

      {/* Knowledge Inspector Modal */}
      {inspectorItem && (
        <KnowledgeInspector
          item={inspectorItem}
          open={!!inspectorItem}
          onOpenChange={(open) => {
            if (!open) setInspectorItem(null);
          }}
          initialTab={inspectorInitialTab}
        />
      )}
    </div>
  );
};
