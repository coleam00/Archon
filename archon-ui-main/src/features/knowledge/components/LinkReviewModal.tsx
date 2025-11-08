/**
 * Link Review Modal Component
 * Displays links from link collections (llms.txt, sitemap.xml) for user review before crawling
 */

import { CheckCircle2, Filter, XCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { Button, Input, Label } from "../../ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { cn, glassCard } from "../../ui/primitives/styles";
import type { LinkPreviewResponse, PreviewLink } from "../types";

interface LinkReviewModalProps {
  open: boolean;
  previewData: LinkPreviewResponse | null;
  initialIncludePatterns: string;
  initialExcludePatterns: string;
  onProceed: (selectedUrls: string[]) => void;
  onCancel: () => void;
}

export const LinkReviewModal: React.FC<LinkReviewModalProps> = ({
  open,
  previewData,
  initialIncludePatterns,
  initialExcludePatterns,
  onProceed,
  onCancel,
}) => {
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [includePatterns, setIncludePatterns] = useState(initialIncludePatterns);
  const [excludePatterns, setExcludePatterns] = useState(initialExcludePatterns);
  const [filteredLinks, setFilteredLinks] = useState<PreviewLink[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  // Initialize selected URLs when modal opens
  useEffect(() => {
    if (previewData && previewData.links) {
      // Auto-select links that match filters
      const initialSelection = new Set<string>(
        previewData.links.filter((link) => link.matches_filter).map((link) => link.url)
      );
      setSelectedUrls(initialSelection);
      setFilteredLinks(previewData.links);
    }
  }, [previewData]);

  // Apply search filter
  useEffect(() => {
    if (!previewData) return;

    const filtered = previewData.links.filter((link) => {
      if (!searchTerm) return true;
      const searchLower = searchTerm.toLowerCase();
      return (
        link.url.toLowerCase().includes(searchLower) ||
        link.text.toLowerCase().includes(searchLower) ||
        link.path.toLowerCase().includes(searchLower)
      );
    });

    setFilteredLinks(filtered);
  }, [searchTerm, previewData]);

  const handleToggleLink = (url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedUrls(new Set(filteredLinks.map((link) => link.url)));
  };

  const handleDeselectAll = () => {
    setSelectedUrls(new Set());
  };

  const handleInvertSelection = () => {
    setSelectedUrls((prev) => {
      const next = new Set<string>();
      filteredLinks.forEach((link) => {
        if (!prev.has(link.url)) {
          next.add(link.url);
        }
      });
      return next;
    });
  };

  const handleApplyFilters = async () => {
    if (!previewData) return;

    try {
      // Parse patterns
      const includePatternArray = includePatterns
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const excludePatternArray = excludePatterns
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      // Re-fetch preview with new patterns
      const response = await fetch("http://localhost:8181/api/crawl/preview-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: previewData.source_url,
          url_include_patterns: includePatternArray,
          url_exclude_patterns: excludePatternArray,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to apply filters");
      }

      const updatedData = await response.json();

      // Update filtered links and auto-select matching ones
      setFilteredLinks(updatedData.links);
      const newSelection = new Set<string>(
        updatedData.links.filter((link: PreviewLink) => link.matches_filter).map((link: PreviewLink) => link.url)
      );
      setSelectedUrls(newSelection);
    } catch (error) {
      console.error("Failed to apply filters:", error);
    }
  };

  const handleProceed = () => {
    onProceed(Array.from(selectedUrls));
  };

  if (!previewData) return null;

  const selectedCount = selectedUrls.size;
  const totalCount = filteredLinks.length;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <DialogContent className="sm:max-w-[800px] p-0 my-4" style={{ height: "90vh", maxHeight: "90vh" }}>
        <div className="h-full flex flex-col">
          <div className="px-6 pt-4 pb-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <DialogHeader>
              <DialogTitle className="text-lg">Review Links - {previewData.collection_type}</DialogTitle>
            </DialogHeader>
            <div className="space-y-0.5 text-sm text-gray-600 dark:text-gray-400 -mt-2">
              <div className="truncate">{previewData.source_url}</div>
              <div className="font-medium text-cyan-600 dark:text-cyan-400">
                {selectedCount} of {totalCount} links selected
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col px-6 py-3 space-y-3 overflow-hidden">
            {/* Filter Section */}
            <div className={cn("space-y-2 p-3 rounded-lg flex-shrink-0", glassCard.blur.sm, glassCard.transparency.light)}>
              <div className="flex items-center space-x-2">
                <Filter className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-900 dark:text-white/90">Filter Patterns</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="modalInclude" className="text-xs">
                    Include Patterns
                  </Label>
                  <Input
                    id="modalInclude"
                    value={includePatterns}
                    onChange={(e) => setIncludePatterns(e.target.value)}
                    placeholder="**/en/**"
                    className="h-8 text-sm"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="modalExclude" className="text-xs">
                    Exclude Patterns
                  </Label>
                  <Input
                    id="modalExclude"
                    value={excludePatterns}
                    onChange={(e) => setExcludePatterns(e.target.value)}
                    placeholder="**/fr/**, **/de/**"
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <Button onClick={handleApplyFilters} variant="outline" size="sm" className="w-full h-8 text-xs">
                <Filter className="w-3 h-3 mr-2" />
                Apply Filters
              </Button>
            </div>

            {/* Bulk Actions Bar */}
            <div className="flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex gap-2">
                <Button onClick={handleSelectAll} variant="outline" size="sm" className="text-xs px-3 py-1 h-8">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Select All
                </Button>
                <Button onClick={handleDeselectAll} variant="outline" size="sm" className="text-xs px-3 py-1 h-8">
                  <XCircle className="w-3 h-3 mr-1" />
                  Deselect All
                </Button>
                <Button onClick={handleInvertSelection} variant="outline" size="sm" className="text-xs px-3 py-1 h-8">
                  Invert
                </Button>
              </div>

              <Input
                type="text"
                placeholder="Search links..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-64 h-8 text-sm"
              />
            </div>

            {/* Link List (scrollable) */}
            <div className="flex-1 min-h-0 border border-gray-200 dark:border-gray-700 rounded-lg overflow-y-auto">
              <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredLinks.map((link) => (
                  <div
                    key={link.url}
                    className={cn(
                      "flex items-start space-x-3 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer transition-colors",
                      selectedUrls.has(link.url) && "bg-cyan-50 dark:bg-cyan-900/20"
                    )}
                    onClick={() => handleToggleLink(link.url)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedUrls.has(link.url)}
                      onChange={() => handleToggleLink(link.url)}
                      className="mt-1 h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300 rounded"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{link.text || "Untitled"}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{link.url}</p>
                          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Path: {link.path}</p>
                        </div>

                        {link.matches_filter && (
                          <span className="flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                            Matches Filter
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {filteredLinks.length === 0 && (
                  <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                    <p>No links found matching your search.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer Actions - Sticky */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex-shrink-0">
            <Button onClick={onCancel} variant="outline">
              Cancel
            </Button>

            <Button
              onClick={handleProceed}
              disabled={selectedCount === 0}
              className={cn(
                "bg-gradient-to-r from-cyan-500 to-cyan-600",
                "hover:from-cyan-600 hover:to-cyan-700",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              Proceed with {selectedCount} Selected Link{selectedCount !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
