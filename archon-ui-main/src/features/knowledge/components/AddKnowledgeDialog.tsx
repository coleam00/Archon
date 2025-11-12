/**
 * Add Knowledge Dialog Component
 * Modal for crawling URLs or uploading documents
 */

import { Globe, Loader2, Upload } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useToast } from "@/features/shared/hooks/useToast";
import { callAPIWithETag } from "@/features/shared/api/apiClient";
import { Button, Input, Label } from "../../ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { cn, glassCard } from "../../ui/primitives/styles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives/tabs";
import { useCrawlUrl, useUploadDocument } from "../hooks";
import type { CrawlRequest, UploadMetadata, LinkPreviewResponse } from "../types";
import { KnowledgeTypeSelector } from "./KnowledgeTypeSelector";
import { LevelSelector } from "./LevelSelector";
import { TagInput } from "./TagInput";
import { LinkReviewModal } from "./LinkReviewModal";

interface AddKnowledgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onCrawlStarted?: (progressId: string) => void;
}

export const AddKnowledgeDialog: React.FC<AddKnowledgeDialogProps> = ({
  open,
  onOpenChange,
  onSuccess,
  onCrawlStarted,
}) => {
  const [activeTab, setActiveTab] = useState<"crawl" | "upload">("crawl");
  const { showToast } = useToast();
  const crawlMutation = useCrawlUrl();
  const uploadMutation = useUploadDocument();

  // Generate unique IDs for form elements
  const urlId = useId();
  const fileId = useId();

  // Crawl form state
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlType, setCrawlType] = useState<"technical" | "business">("technical");
  const [maxDepth, setMaxDepth] = useState("2");
  const [tags, setTags] = useState<string[]>([]);

  // Glob pattern filtering state (unified field with ! prefix for exclusions)
  const [urlPatterns, setUrlPatterns] = useState("");
  const [reviewLinksEnabled, setReviewLinksEnabled] = useState(true);

  // Link review modal state
  const [showLinkReviewModal, setShowLinkReviewModal] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);

  // Upload form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadType, setUploadType] = useState<"technical" | "business">("technical");
  const [uploadTags, setUploadTags] = useState<string[]>([]);

  // Auto-detect GitHub repositories and populate smart defaults
  useEffect(() => {
    // Only auto-populate if the URL has changed and patterns are empty
    if (!crawlUrl) return;

    // Detect GitHub URL (supports https://, http://, or just github.com)
    const githubUrlPattern = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/\?#]+)/i;
    const match = crawlUrl.match(githubUrlPattern);

    if (match) {
      // Only auto-populate if patterns are currently empty (don't override user edits)
      if (!urlPatterns) {
        // Use code-only patterns: only crawl tree (directories) and blob (files) pages
        setUrlPatterns("**/tree/**, **/blob/**");
      }

      // Auto-add "GitHub Repo" tag if not already present
      if (!tags.includes("GitHub Repo")) {
        setTags((prevTags) => [...prevTags, "GitHub Repo"]);
      }

      // Set max depth to 3 for GitHub repos (to traverse nested directories)
      if (maxDepth === "2") {
        setMaxDepth("3");
      }
    }
  }, [crawlUrl]); // Only depend on crawlUrl to avoid infinite loops

  const resetForm = () => {
    setCrawlUrl("");
    setCrawlType("technical");
    setMaxDepth("2");
    setTags([]);
    setUrlPatterns("");
    setReviewLinksEnabled(true);
    setSelectedFile(null);
    setUploadType("technical");
    setUploadTags([]);
  };

  // Parse unified pattern string into separate include/exclude arrays.
  // Patterns starting with ! are exclusions, others are inclusions.
  // Example: "path1, path2, !exclude1" -> { include: ["path1", "path2"], exclude: ["exclude1"] }
  const parseUrlPatterns = (patterns: string): { include: string[]; exclude: string[] } => {
    const include: string[] = [];
    const exclude: string[] = [];

    patterns
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .forEach((pattern) => {
        if (pattern.startsWith("!")) {
          // Exclude pattern - remove the ! prefix
          exclude.push(pattern.substring(1).trim());
        } else {
          // Include pattern
          include.push(pattern);
        }
      });

    return { include, exclude };
  };

  const handleCrawl = async () => {
    if (!crawlUrl) {
      showToast("Please enter a URL to crawl", "error");
      return;
    }

    try {
      // Parse unified pattern string into include/exclude arrays
      const { include: includePatternArray, exclude: excludePatternArray } = parseUrlPatterns(urlPatterns);

      // If review is enabled, call preview endpoint first
      if (reviewLinksEnabled) {
        const previewData = await callAPIWithETag<LinkPreviewResponse>("/crawl/preview-links", {
          method: "POST",
          body: JSON.stringify({
            url: crawlUrl,
            url_include_patterns: includePatternArray,
            url_exclude_patterns: excludePatternArray,
          }),
        });

        // If it's a link collection, show the review modal
        if (previewData.is_link_collection) {
          setPreviewData(previewData);
          setShowLinkReviewModal(true);
          return; // Don't proceed with crawl yet
        }

        // Not a link collection - proceed with normal crawl
        showToast("Not a link collection - proceeding with normal crawl", "info");
      }

      // Build crawl request (for non-link collections or when review is disabled)
      const request: CrawlRequest = {
        url: crawlUrl,
        knowledge_type: crawlType,
        max_depth: parseInt(maxDepth, 10),
        tags: tags.length > 0 ? tags : undefined,
        url_include_patterns: includePatternArray.length > 0 ? includePatternArray : undefined,
        url_exclude_patterns: excludePatternArray.length > 0 ? excludePatternArray : undefined,
        skip_link_review: !reviewLinksEnabled,
      };

      const response = await crawlMutation.mutateAsync(request);

      // Notify parent about the new crawl operation
      if (response?.progressId && onCrawlStarted) {
        onCrawlStarted(response.progressId);
      }

      showToast("Crawl started successfully", "success");
      resetForm();
      onSuccess();
      onOpenChange(false);
    } catch (error) {
      // Display the actual error message from backend
      const message = error instanceof Error ? error.message : "Failed to start crawl";
      showToast(message, "error");
    }
  };

  // Handle link review modal submission
  const handleLinkReviewSubmit = async (selectedUrls: string[]) => {
    try {
      // Parse unified pattern string into include/exclude arrays
      const { include: includePatternArray, exclude: excludePatternArray } = parseUrlPatterns(urlPatterns);

      const request: CrawlRequest = {
        url: crawlUrl,
        knowledge_type: crawlType,
        max_depth: parseInt(maxDepth, 10),
        tags: tags.length > 0 ? tags : undefined,
        url_include_patterns: includePatternArray.length > 0 ? includePatternArray : undefined,
        url_exclude_patterns: excludePatternArray.length > 0 ? excludePatternArray : undefined,
        selected_urls: selectedUrls,
        skip_link_review: false,
      };

      const response = await crawlMutation.mutateAsync(request);

      // Notify parent about the new crawl operation
      if (response?.progressId && onCrawlStarted) {
        onCrawlStarted(response.progressId);
      }

      showToast(`Crawl started with ${selectedUrls.length} selected links`, "success");
      resetForm();
      setShowLinkReviewModal(false);
      setPreviewData(null);
      onSuccess();
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start crawl";
      showToast(message, "error");
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      showToast("Please select a file to upload", "error");
      return;
    }

    try {
      const metadata: UploadMetadata = {
        knowledge_type: uploadType,
        tags: uploadTags.length > 0 ? uploadTags : undefined,
      };

      const response = await uploadMutation.mutateAsync({ file: selectedFile, metadata });

      // Notify parent about the new upload operation if it has a progressId
      if (response?.progressId && onCrawlStarted) {
        onCrawlStarted(response.progressId);
      }

      // Upload happens in background - show appropriate message
      showToast(`Upload started for ${selectedFile.name}. Processing in background...`, "info");
      resetForm();
      // Don't call onSuccess here - the upload hasn't actually succeeded yet
      // onSuccess should be called when polling shows completion
      onOpenChange(false);
    } catch (error) {
      // Display the actual error message from backend
      const message = error instanceof Error ? error.message : "Failed to upload document";
      showToast(message, "error");
    }
  };

  const isProcessing = crawlMutation.isPending || uploadMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add Knowledge</DialogTitle>
          <DialogDescription>Crawl websites or upload documents to expand your knowledge base.</DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "crawl" | "upload")}>
          <div className="flex justify-center">
            <TabsList>
              <TabsTrigger value="crawl" color="blue">
                <Globe className="w-4 h-4 mr-2" />
                Crawl Website
              </TabsTrigger>
              <TabsTrigger value="upload" color="purple">
                <Upload className="w-4 h-4 mr-2" />
                Upload Document
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Crawl Tab */}
          <TabsContent value="crawl" className="space-y-6 mt-6">
            {/* Enhanced URL Input Section */}
            <div className="space-y-3">
              <Label htmlFor={urlId} className="text-sm font-medium text-gray-900 dark:text-white/90">
                Website URL
              </Label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Globe className="h-5 w-5" style={{ color: "#0891b2" }} />
                </div>
                <Input
                  id={urlId}
                  type="url"
                  placeholder="https://docs.example.com or https://github.com/username/repo (auto-configured)"
                  value={crawlUrl}
                  onChange={(e) => setCrawlUrl(e.target.value)}
                  disabled={isProcessing}
                  className={cn(
                    "pl-10 h-12",
                    glassCard.blur.md,
                    glassCard.transparency.medium,
                    "border-gray-300/60 dark:border-gray-600/60 focus:border-cyan-400/70",
                  )}
                />
              </div>
            </div>

            {/* Glob Pattern Filtering Section */}
            <div className="space-y-4 border-t border-gray-200/50 dark:border-gray-700/50 pt-4">
              {/* GitHub Auto-Configuration Notice */}
              {crawlUrl.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/\?#]+)/i) && (
                <div className="flex items-start space-x-2 p-3 bg-cyan-50/50 dark:bg-cyan-900/20 border border-cyan-200/50 dark:border-cyan-700/50 rounded-lg">
                  <div className="flex-shrink-0 mt-0.5">
                    <Globe className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                  </div>
                  <div className="flex-1 text-xs text-cyan-800 dark:text-cyan-300">
                    <strong>GitHub Repository Detected:</strong> Pattern auto-configured to crawl only this repository (depth=3).
                    Add exclusions with <code className="px-1 py-0.5 bg-cyan-100 dark:bg-cyan-800 rounded">!**/issues**</code> if needed.
                  </div>
                </div>
              )}

              {/* Review Links Checkbox */}
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="reviewLinksCheck"
                  checked={reviewLinksEnabled}
                  onChange={(e) => setReviewLinksEnabled(e.target.checked)}
                  disabled={isProcessing}
                  className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-300 rounded"
                />
                <Label
                  htmlFor="reviewLinksCheck"
                  className="text-sm font-medium text-gray-900 dark:text-white/90 cursor-pointer"
                >
                  Review discovered links before crawling?
                </Label>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 ml-6">
                When enabled, you'll preview and select links from llms.txt or sitemap files before crawling starts
              </div>

              {/* Unified URL Patterns Input */}
              <div className="space-y-2">
                <Label htmlFor="urlPatterns" className="text-sm font-medium text-gray-900 dark:text-white/90">
                  URL Patterns (comma-separated, optional)
                </Label>
                <Input
                  id="urlPatterns"
                  type="text"
                  placeholder="e.g., **/en/**, **/docs/**, !**/api/**, !**/changelog/** (use ! to exclude)"
                  value={urlPatterns}
                  onChange={(e) => setUrlPatterns(e.target.value)}
                  disabled={isProcessing}
                  className={cn(
                    "h-10",
                    glassCard.blur.sm,
                    glassCard.transparency.medium,
                    "border-gray-300/60 dark:border-gray-600/60 focus:border-cyan-400/70",
                  )}
                />
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  <strong>Glob patterns:</strong> Include URLs with patterns like <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">**/en/**</code>.
                  Exclude with <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">!**/api/**</code> prefix (like .gitignore).
                  Leave empty to crawl all discovered links.
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <KnowledgeTypeSelector value={crawlType} onValueChange={setCrawlType} disabled={isProcessing} />

              <LevelSelector value={maxDepth} onValueChange={setMaxDepth} disabled={isProcessing} />
            </div>

            <TagInput
              tags={tags}
              onTagsChange={setTags}
              disabled={isProcessing}
              placeholder="Add tags like 'api', 'documentation', 'guide'..."
            />

            <Button
              onClick={handleCrawl}
              disabled={isProcessing || !crawlUrl}
              className={[
                "w-full bg-gradient-to-r from-cyan-500 to-cyan-600",
                "hover:from-cyan-600 hover:to-cyan-700",
                "backdrop-blur-md border border-cyan-400/50",
                "shadow-[0_0_20px_rgba(6,182,212,0.25)] hover:shadow-[0_0_30px_rgba(6,182,212,0.35)]",
                "transition-all duration-200",
              ].join(" ")}
            >
              {crawlMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Starting Crawl...
                </>
              ) : (
                <>
                  <Globe className="w-4 h-4 mr-2" />
                  Start Crawling
                </>
              )}
            </Button>
          </TabsContent>

          {/* Upload Tab */}
          <TabsContent value="upload" className="space-y-6 mt-6">
            {/* Enhanced File Input Section */}
            <div className="space-y-3">
              <Label htmlFor={fileId} className="text-sm font-medium text-gray-900 dark:text-white/90">
                Document File
              </Label>

              {/* Custom File Upload Area */}
              <div className="relative">
                <input
                  id={fileId}
                  type="file"
                  accept=".txt,.md,.pdf,.doc,.docx,.html,.htm"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  disabled={isProcessing}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
                />
                <div
                  className={cn(
                    "relative h-20 rounded-xl border-2 border-dashed transition-all duration-200",
                    "flex flex-col items-center justify-center gap-2 text-center p-4",
                    glassCard.blur.md,
                    selectedFile ? glassCard.tints.purple.light : glassCard.transparency.medium,
                    selectedFile ? "border-purple-400/70" : "border-gray-300/60 dark:border-gray-600/60",
                    !selectedFile && "hover:border-purple-400/50",
                    isProcessing && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <Upload
                    className={cn("w-6 h-6", selectedFile ? "text-purple-500" : "text-gray-400 dark:text-gray-500")}
                  />
                  <div className="text-sm">
                    {selectedFile ? (
                      <div className="space-y-1">
                        <p className="font-medium text-purple-700 dark:text-purple-400">{selectedFile.name}</p>
                        <p className="text-xs text-purple-600 dark:text-purple-400">
                          {Math.round(selectedFile.size / 1024)} KB
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <p className="font-medium text-gray-700 dark:text-gray-300">Click to browse or drag & drop</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          PDF, DOC, DOCX, TXT, MD files supported
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <KnowledgeTypeSelector value={uploadType} onValueChange={setUploadType} disabled={isProcessing} />

            <TagInput
              tags={uploadTags}
              onTagsChange={setUploadTags}
              disabled={isProcessing}
              placeholder="Add tags like 'manual', 'reference', 'guide'..."
            />

            <Button
              onClick={handleUpload}
              disabled={isProcessing || !selectedFile}
              className={[
                "w-full bg-gradient-to-r from-purple-500 to-purple-600",
                "hover:from-purple-600 hover:to-purple-700",
                "backdrop-blur-md border border-purple-400/50",
                "shadow-[0_0_20px_rgba(147,51,234,0.25)] hover:shadow-[0_0_30px_rgba(147,51,234,0.35)]",
                "transition-all duration-200",
              ].join(" ")}
            >
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Upload Document
                </>
              )}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>

      {/* Link Review Modal */}
      {showLinkReviewModal && previewData && (
        <LinkReviewModal
          open={showLinkReviewModal}
          previewData={previewData}
          initialUrlPatterns={urlPatterns}
          onProceed={handleLinkReviewSubmit}
          onCancel={() => {
            setShowLinkReviewModal(false);
            setPreviewData(null);
          }}
        />
      )}
    </Dialog>
  );
};
