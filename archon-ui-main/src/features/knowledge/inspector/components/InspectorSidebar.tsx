/**
 * Inspector Sidebar Component
 * Displays list of documents or code examples with search
 */

import { motion } from "framer-motion";
import { Code, FileText, Globe, Hash, Loader2, Search } from "lucide-react";
import { useMemo } from "react";
import { Button, Input } from "../../../ui/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../ui/primitives/select";
import { cn } from "../../../ui/primitives/styles";
import type { CodeExample, DocumentChunk } from "../../types";
import { extractDomain } from "../../utils/knowledge-utils";

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
  selectedDomain?: string;
  onDomainChange?: (domain: string) => void;
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
  selectedDomain = "all",
  onDomainChange,
}) => {

  // Extract unique domains from documents
  const domainStats = useMemo(() => {
    if (viewMode !== "documents") return [];

    const stats = new Map<string, number>();
    (items as DocumentChunk[]).forEach((doc) => {
      const url = doc.url || doc.metadata?.url;
      if (url) {
        const domain = extractDomain(url);
        stats.set(domain, (stats.get(domain) || 0) + 1);
      }
    });

    return Array.from(stats.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([domain, count]) => ({ domain, count }));
  }, [items, viewMode]);

  // Filter items by selected domain
  const filteredItems = useMemo(() => {
    if (viewMode !== "documents" || selectedDomain === "all") {
      return items;
    }

    return (items as DocumentChunk[]).filter((doc) => {
      const url = doc.url || doc.metadata?.url;
      if (!url) return false;
      return extractDomain(url) === selectedDomain;
    });
  }, [items, selectedDomain, viewMode]);

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
    <aside className="w-80 border-r border-white/10 flex flex-col bg-black/40" aria-label="Document and code browser">
      {/* Search and Filters */}
      <div className="p-4 border-b border-white/10 flex-shrink-0 space-y-3">
        {/* Search Bar */}
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none"
            aria-hidden="true"
          />
          <Input
            placeholder={`Search ${viewMode}...`}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 bg-black/30"
            aria-label={`Search ${viewMode}`}
          />
        </div>

        {/* Domain Filter Dropdown - Only show for documents */}
        {viewMode === "documents" && domainStats.length > 0 && onDomainChange && (
          <div className="space-y-2">
            <div className="text-xs text-gray-400 flex items-center gap-2">
              <Globe className="w-3 h-3" />
              Domain Filter
            </div>
            <Select value={selectedDomain} onValueChange={onDomainChange}>
              <SelectTrigger className="w-full h-8 text-xs bg-black/30 border-white/10">
                <SelectValue placeholder="Select domain" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  All domains ({items.length} documents)
                </SelectItem>
                {domainStats.map(({ domain, count }) => (
                  <SelectItem key={domain} value={domain} className="text-xs">
                    <div className="flex items-center justify-between w-full">
                      <span className="truncate">{domain}</span>
                      <span className="ml-2 px-1.5 py-0.5 bg-white/10 rounded text-[10px] font-mono">
                        {count}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Item List */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
        {isLoading ? (
          <div className="p-4 text-center text-gray-500" aria-live="polite">
            <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" aria-hidden="true" />
            <span>Loading {viewMode}...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="p-4 text-center text-gray-500">
            No {viewMode} found
            {searchQuery && <p className="text-xs mt-1">Try adjusting your search</p>}
          </div>
        ) : (
          <div className="p-2">
            {filteredItems.map((item) => (
              <div key={item.id} className="mb-1">
                <motion.div
                  whileHover={{ x: 2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onItemSelect(item)}
                  className={cn(
                    "w-full text-left p-3 rounded-lg transition-all cursor-pointer",
                    "hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-cyan-500/50",
                    selectedItemId === item.id
                      ? "bg-cyan-500/10 border border-cyan-500/30 ring-1 ring-cyan-500/20"
                      : "border border-transparent",
                  )}
                  role="option"
                  aria-selected={selectedItemId === item.id}
                  aria-label={`${getItemTitle(item)}. ${getItemDescription(item)}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Icon - Fixed size */}
                    <div className="mt-0.5 flex-shrink-0" aria-hidden="true">
                      {viewMode === "documents" ? (
                        <FileText className="w-4 h-4 text-cyan-400" />
                      ) : (
                        <Code className="w-4 h-4 text-green-400" />
                      )}
                    </div>

                    {/* Content - Can shrink with proper overflow */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 min-w-0">
                        <span className="text-sm font-medium text-white/90 truncate flex-1" title={getItemTitle(item)}>
                          {getItemTitle(item)}
                        </span>
                        {viewMode === "code" && (item as CodeExample).language && (
                          <span className="px-1.5 py-0.5 bg-green-500/10 text-green-400 text-xs rounded flex-shrink-0">
                            {(item as CodeExample).language}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-2" title={getItemDescription(item)}>
                        {getItemDescription(item)}
                      </p>

                      {item.metadata?.relevance_score != null && (
                        <div className="flex items-center gap-1 mt-1">
                          <Hash className="w-3 h-3 text-gray-600" aria-hidden="true" />
                          <span className="text-xs text-gray-600">
                            {(item.metadata.relevance_score * 100).toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              </div>
            ))}

            {/* Load More Button */}
            {hasNextPage && !isLoading && (
              <div className="p-3 mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadMore}
                  disabled={isFetchingNextPage}
                  className="w-full text-cyan-400 hover:text-white hover:bg-cyan-500/10 transition-all"
                  aria-label={`Load more ${viewMode}`}
                >
                  {isFetchingNextPage ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                      <span>Loading...</span>
                    </>
                  ) : (
                    <>
                      <span>Load More {viewMode}</span>
                      <span className="sr-only"> Press to load additional items.</span>
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};