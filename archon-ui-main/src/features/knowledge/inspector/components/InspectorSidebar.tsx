/**
 * Inspector Sidebar Component
 * Displays list of documents or code examples with search
 */

import { motion } from "framer-motion";
import { Code, FileText, Hash, Loader2, Search } from "lucide-react";
import { Button, Input } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import type { CodeExample, DocumentChunk } from "../../types";

interface InspectorSidebarProps {
  viewMode: "documents" | "code";
  searchQuery: string;
  onSearchChange: (query: string) => void;
  items: DocumentChunk[] | CodeExample[];
  selectedItemId: string | null;
  onItemSelect: (item: DocumentChunk | CodeExample) => void;
  isLoading: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  isFetchingNextPage: boolean;
}

export const InspectorSidebar: React.FC<InspectorSidebarProps> = ({
  viewMode,
  searchQuery,
  onSearchChange,
  items,
  selectedItemId,
  onItemSelect,
  isLoading,
  hasNextPage,
  onLoadMore,
  isFetchingNextPage,
}) => {
  const getItemTitle = (item: DocumentChunk | CodeExample) => {
    const idSuffix = String(item.id).slice(-6);
    if (viewMode === "documents") {
      const doc = item as DocumentChunk;
      // Use top-level title (from filename/headers), fallback to metadata, then generic
      return doc.title || doc.metadata?.title || doc.metadata?.section || `Document ${idSuffix}`;
    }
    const code = item as CodeExample;
    // Use AI-generated title first, fallback to filename, then summary, then generic
    return (
      code.title || code.example_name || code.file_path?.split("/").pop() || code.summary || `Code Example ${idSuffix}`
    );
  };

  const getItemDescription = (item: DocumentChunk | CodeExample) => {
    if (viewMode === "documents") {
      const doc = item as DocumentChunk;
      // Use formatted section, fallback to metadata section, then content preview
      const preview = doc.content ? `${doc.content.substring(0, 100)}...` : "No preview available";
      return doc.section || doc.metadata?.section || preview;
    }
    const code = item as CodeExample;
    // Summary is most descriptive, then language
    return code.summary || (code.language ? `${code.language} code snippet` : "Code snippet");
  };

  return (
    <div className="w-80 border-r border-white/10 flex flex-col bg-black/40">
      {/* Search */}
      <div className="p-4 border-b border-white/10">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <Input
            placeholder={`Search ${viewMode}...`}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 bg-black/30"
          />
        </div>
      </div>

      {/* Item List */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
        {isLoading ? (
          <div className="p-4 text-center text-gray-500">Loading...</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-center text-gray-500">No {viewMode} found</div>
        ) : (
          <div className="p-2">
            {items.map((item) => (
              <motion.button
                type="button"
                key={item.id}
                whileHover={{ x: 2 }}
                onClick={() => onItemSelect(item)}
                className={cn(
                  "w-full text-left p-3 rounded-lg mb-1 transition-colors",
                  "hover:bg-white/5",
                  selectedItemId === item.id ? "bg-cyan-500/10 border border-cyan-500/30" : "border border-transparent",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {viewMode === "documents" ? (
                      <FileText className="w-4 h-4 text-cyan-400" />
                    ) : (
                      <Code className="w-4 h-4 text-green-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-white/90 truncate">{getItemTitle(item)}</span>
                      {viewMode === "code" && (item as CodeExample).language && (
                        <span className="px-1.5 py-0.5 bg-green-500/10 text-green-400 text-xs rounded">
                          {(item as CodeExample).language}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-2">{getItemDescription(item)}</p>
                    {item.metadata?.relevance_score != null && (
                      <div className="flex items-center gap-1 mt-1">
                        <Hash className="w-3 h-3 text-gray-600" />
                        <span className="text-xs text-gray-600">
                          {(item.metadata.relevance_score * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </motion.button>
            ))}

            {/* Load More Button */}
            {hasNextPage && !isLoading && (
              <div className="p-3 border-t border-white/10">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadMore}
                  disabled={isFetchingNextPage}
                  className="w-full text-cyan-400 hover:text-white hover:bg-cyan-500/10"
                >
                  {isFetchingNextPage ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load More ${viewMode}`
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
