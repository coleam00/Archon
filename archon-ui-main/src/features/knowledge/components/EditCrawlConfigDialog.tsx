/**
 * Edit Crawl Configuration Dialog
 * Allows editing existing crawler configuration for knowledge items
 */

import { AlertCircle, Globe, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "../../ui/hooks/useToast";
import { Button, Input, Label } from "../../ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { useKnowledgeItem, useUpdateCrawlConfig } from "../hooks";
import type { CrawlConfig } from "../types";
import { AdvancedCrawlConfig } from "./AdvancedCrawlConfig";
import { KnowledgeTypeSelector } from "./KnowledgeTypeSelector";
import { LevelSelector } from "./LevelSelector";
import { TagInput } from "./TagInput";

interface EditCrawlConfigDialogProps {
  sourceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export const EditCrawlConfigDialog: React.FC<EditCrawlConfigDialogProps> = ({
  sourceId,
  open,
  onOpenChange,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const { data: item, isLoading: itemLoading, error: itemError } = useKnowledgeItem(open ? sourceId : null);
  const updateMutation = useUpdateCrawlConfig();

  // Form state
  const [url, setUrl] = useState("");
  const [knowledgeType, setKnowledgeType] = useState<"technical" | "business">("technical");
  const [maxDepth, setMaxDepth] = useState("2");
  const [tags, setTags] = useState<string[]>([]);
  const [crawlConfig, setCrawlConfig] = useState<CrawlConfig>({});

  // Reset form when dialog opens
  useEffect(() => {
    if (open && !item) {
      // Reset to defaults while loading
      setUrl("");
      setKnowledgeType("technical");
      setMaxDepth("2");
      setTags([]);
      setCrawlConfig({});
    }
  }, [open, item]);

  // Load existing configuration when item loads
  useEffect(() => {
    if (item && open) {
      // Use original_url if available (the actual crawled URL), otherwise fall back to url
      const urlToEdit = item.metadata?.original_url || item.url || "";
      setUrl(urlToEdit);

      // Knowledge type is also a required field
      setKnowledgeType(item.knowledge_type || "technical");

      // Check for max_depth at various locations
      const depthValue =
        item.max_depth ||
        item.metadata?.max_depth ||
        item.metadata?.crawl_config?.max_depth ||
        2;
      setMaxDepth(depthValue.toString());

      // Check for tags at various locations
      const tagsValue =
        item.tags ||
        item.metadata?.tags ||
        [];
      setTags(Array.isArray(tagsValue) ? tagsValue : []);

      // Load existing crawl config if available
      // It could be at top level or nested in metadata
      const configValue =
        item.crawl_config ||
        item.metadata?.crawl_config ||
        {};

      console.log("EditCrawlConfigDialog - Loading item:", item);
      console.log("EditCrawlConfigDialog - Config value:", configValue);

      // Ensure the config has the right shape with proper defaults
      const finalConfig = {
        allowed_domains: Array.isArray(configValue.allowed_domains) ? configValue.allowed_domains : [],
        excluded_domains: Array.isArray(configValue.excluded_domains) ? configValue.excluded_domains : [],
        include_patterns: Array.isArray(configValue.include_patterns) ? configValue.include_patterns : [],
        exclude_patterns: Array.isArray(configValue.exclude_patterns) ? configValue.exclude_patterns : []
      };

      console.log("EditCrawlConfigDialog - Setting config to:", finalConfig);
      setCrawlConfig(finalConfig);
    }
  }, [item, open]);

  const handleSave = async () => {
    if (!url) {
      showToast("URL is required", "error");
      return;
    }

    try {
      const updateData = {
        sourceId,
        url,
        knowledge_type: knowledgeType,
        max_depth: parseInt(maxDepth, 10),
        tags: tags.length > 0 ? tags : undefined,
        crawl_config: crawlConfig,
      };

      console.log("EditCrawlConfigDialog - Saving config:", updateData);
      await updateMutation.mutateAsync(updateData);

      showToast("Configuration updated. Recrawl initiated.", "success");
      onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update configuration";
      showToast(message, "error");
    }
  };

  const isProcessing = updateMutation.isPending;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0 pb-2">
          <DialogTitle>Edit Crawler Configuration</DialogTitle>
          <DialogDescription>
            Update the crawler settings for this knowledge item
          </DialogDescription>
        </DialogHeader>

        {itemLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
          </div>
        ) : itemError ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-red-400">
              <AlertCircle className="w-6 h-6 mx-auto mb-2" />
              <p>Failed to load configuration</p>
              <p className="text-sm text-gray-400 mt-1">{itemError.message}</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-6 px-6 pb-6">
              {/* Warning Alert */}
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex gap-3">
                <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-amber-200">
                  Saving changes will trigger a recrawl with the new configuration.
                  Existing documents will be replaced with newly crawled content.
                </div>
              </div>

              {/* URL Input */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-gray-900 dark:text-white/90">
                  Website URL
                </Label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Globe className="h-5 w-5" style={{ color: "#0891b2" }} />
                  </div>
                  <Input
                    type="url"
                    placeholder="https://docs.example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    disabled={isProcessing}
                    className="pl-10 h-12 backdrop-blur-md bg-gradient-to-r from-white/60 to-white/50 dark:from-black/60 dark:to-black/50"
                  />
                </div>
              </div>

              {/* Advanced Configuration */}
              <AdvancedCrawlConfig config={crawlConfig} onChange={setCrawlConfig} />

              {/* Knowledge Type */}
              <KnowledgeTypeSelector
                value={knowledgeType}
                onValueChange={setKnowledgeType}
                disabled={isProcessing}
              />

              {/* Crawl Depth */}
              <LevelSelector
                value={maxDepth}
                onValueChange={setMaxDepth}
                disabled={isProcessing}
              />

              {/* Tags */}
              <TagInput
                tags={tags}
                onTagsChange={setTags}
                disabled={isProcessing}
                placeholder="Add tags like 'api', 'documentation', 'guide'..."
              />

              {/* Action Buttons */}
              <div className="flex gap-2 pt-4">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={isProcessing}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={isProcessing || !url}
                  className="flex-1 bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Updating & Recrawling...
                    </>
                  ) : (
                    <>
                      <Globe className="w-4 h-4 mr-2" />
                      Save & Recrawl
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </div>
  );
};