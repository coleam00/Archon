/**
 * Knowledge Inspector Modal
 * Orchestrates split-view design with sidebar navigation and content viewer
 */

import { useCallback, useEffect, useState } from "react";
import { InspectorDialog, InspectorDialogContent, InspectorDialogTitle } from "../../../ui/primitives";
import type { CodeExample, DocumentChunk, InspectorSelectedItem, KnowledgeItem } from "../../types";
import { useInspectorPagination } from "../hooks/useInspectorPagination";
import { ContentViewer } from "./ContentViewer";
import { InspectorHeader } from "./InspectorHeader";
import { InspectorSidebar } from "./InspectorSidebar";
import { copyToClipboard } from "../../../shared/utils/clipboard";

interface KnowledgeInspectorProps {
  item: KnowledgeItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "documents" | "code";
}

type ViewMode = "documents" | "code";

export const KnowledgeInspector: React.FC<KnowledgeInspectorProps> = ({
  item,
  open,
  onOpenChange,
  initialTab = "documents",
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>(initialTab);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedItem, setSelectedItem] = useState<InspectorSelectedItem | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Reset view mode when item or initialTab changes
  useEffect(() => {
    setViewMode(initialTab);
    setSelectedItem(null); // Clear selected item when switching tabs
  }, [item.source_id, initialTab]);

  // Use pagination hook for current view mode
  const paginationData = useInspectorPagination({
    sourceId: item.source_id,
    viewMode,
    searchQuery,
  });

  // Get current items based on view mode
  const currentItems = paginationData.items;
  const isLoading = paginationData.isLoading;
  const hasNextPage = paginationData.hasNextPage;
  const fetchNextPage = paginationData.fetchNextPage;
  const isFetchingNextPage = paginationData.isFetchingNextPage;

  // Use metadata counts like KnowledgeCard does - don't rely on loaded data length
  const totalDocumentCount = item.document_count ?? item.metadata?.document_count ?? 0;
  const totalCodeCount = item.code_examples_count ?? item.metadata?.code_examples_count ?? 0;

  // Auto-select first item when data loads
  useEffect(() => {
    if (selectedItem || currentItems.length === 0) return;

    const firstItem = currentItems[0];
    if (viewMode === "documents") {
      const firstDoc = firstItem as DocumentChunk;
      setSelectedItem({
        type: "document",
        id: firstDoc.id,
        content: firstDoc.content || "",
        metadata: {
          title: firstDoc.title || firstDoc.metadata?.title,
          section: firstDoc.section || firstDoc.metadata?.section,
          relevance_score: firstDoc.metadata?.relevance_score,
          url: firstDoc.url || firstDoc.metadata?.url,
          tags: firstDoc.metadata?.tags,
        },
      });
    } else {
      const firstCode = firstItem as CodeExample;
      setSelectedItem({
        type: "code",
        id: String(firstCode.id || ""),
        content: firstCode.content || firstCode.code || "",
        metadata: {
          language: firstCode.language,
          file_path: firstCode.file_path,
          summary: firstCode.summary,
          relevance_score: firstCode.metadata?.relevance_score,
          title: firstCode.title || firstCode.example_name,
        },
      });
    }
  }, [viewMode, currentItems, selectedItem]);

  const handleCopy = useCallback(async (text: string, id: string) => {
    const result = await copyToClipboard(text);
    if (result.success) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((v) => (v === id ? null : v)), 2000);
    } else {
      console.error("Failed to copy to clipboard:", result.error);
    }
  }, []);

  const handleItemSelect = useCallback(
    (item: DocumentChunk | CodeExample) => {
      if (viewMode === "documents") {
        const doc = item as DocumentChunk;
        setSelectedItem({
          type: "document",
          id: doc.id || "",
          content: doc.content || "",
          metadata: {
            title: doc.title || doc.metadata?.title,
            section: doc.section || doc.metadata?.section,
            relevance_score: doc.metadata?.relevance_score,
            url: doc.url || doc.metadata?.url,
            tags: doc.metadata?.tags,
          },
        });
      } else {
        const code = item as CodeExample;
        setSelectedItem({
          type: "code",
          id: String(code.id),
          content: code.content || code.code || "",
          metadata: {
            language: code.language,
            file_path: code.file_path,
            summary: code.summary,
            relevance_score: code.metadata?.relevance_score,
            title: code.title || code.example_name,
          },
        });
      }
    },
    [viewMode],
  );

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setSelectedItem(null);
    setSearchQuery("");
  }, []);

  return (
    <InspectorDialog open={open} onOpenChange={onOpenChange}>
      <InspectorDialogContent>
        <InspectorDialogTitle>Knowledge Inspector - {item.title}</InspectorDialogTitle>

        {/* Header - Fixed */}
        <div className="flex-shrink-0">
          <InspectorHeader
            item={item}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            documentCount={totalDocumentCount}
            codeCount={totalCodeCount}
            filteredDocumentCount={viewMode === "documents" ? currentItems.length : 0}
            filteredCodeCount={viewMode === "code" ? currentItems.length : 0}
          />
        </div>

        {/* Main Content Area - Scrollable */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <InspectorSidebar
            viewMode={viewMode}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            items={currentItems as DocumentChunk[] | CodeExample[]}
            selectedItemId={selectedItem?.id || null}
            onItemSelect={handleItemSelect}
            isLoading={isLoading}
            hasNextPage={hasNextPage}
            onLoadMore={fetchNextPage}
            isFetchingNextPage={isFetchingNextPage}
          />

          {/* Content Viewer */}
          <div className="flex-1 min-h-0 bg-black/20 flex flex-col">
            <ContentViewer selectedItem={selectedItem} onCopy={handleCopy} copiedId={copiedId} />
          </div>
        </div>
      </InspectorDialogContent>
    </InspectorDialog>
  );
};
