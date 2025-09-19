/**
 * Add Knowledge Dialog Component
 * Modal for crawling URLs or uploading documents
 */

import { Files, Folder, Globe, Loader2, Upload } from "lucide-react";
import { useId, useState } from "react";
import { useToast } from "../../ui/hooks/useToast";
import { Button, Input, Label } from "../../ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { cn } from "../../ui/primitives/styles";
import { Tabs, TabsContent } from "../../ui/primitives/tabs";
import { useCrawlUrl, useUploadDocument, useUploadDocumentsBatch } from "../hooks";
import type { CrawlRequest, UploadMetadata } from "../types";
import { KnowledgeTypeSelector } from "./KnowledgeTypeSelector";
import { LevelSelector } from "./LevelSelector";
import { TagInput } from "./TagInput";

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
  const batchUploadMutation = useUploadDocumentsBatch();

  // Generate unique IDs for form elements
  const urlId = useId();
  const fileId = useId();

  // Crawl form state
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlType, setCrawlType] = useState<"technical" | "business">("technical");
  const [maxDepth, setMaxDepth] = useState("2");
  const [tags, setTags] = useState<string[]>([]);

  // Upload form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [groupByFolder, setGroupByFolder] = useState(false);
  const [groupAsSingle, setGroupAsSingle] = useState(false);
  const [groupDisplayName, setGroupDisplayName] = useState('');
  const [uploadType, setUploadType] = useState<"technical" | "business">("technical");
  const [uploadTags, setUploadTags] = useState<string[]>([]);

  const resetForm = () => {
    setCrawlUrl("");
    setCrawlType("technical");
    setMaxDepth("2");
    setTags([]);
    setSelectedFile(null);
    setSelectedFiles([]);
    setGroupByFolder(false);
    setGroupAsSingle(false);
    setGroupDisplayName('');
    setUploadType("technical");
    setUploadTags([]);
  };

  const handleCrawl = async () => {
    if (!crawlUrl) {
      showToast("Please enter a URL to crawl", "error");
      return;
    }

    try {
      const request: CrawlRequest = {
        url: crawlUrl,
        knowledge_type: crawlType,
        max_depth: parseInt(maxDepth, 10),
        tags: tags.length > 0 ? tags : undefined,
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

  const handleUpload = async () => {
    // Determine which files to upload
    const filesToUpload = selectedFiles.length > 0 ? selectedFiles : (selectedFile ? [selectedFile] : []);

    if (filesToUpload.length === 0) {
      showToast("Please select at least one file to upload", "error");
      return;
    }

    try {
      const baseMetadata: UploadMetadata = {
        knowledge_type: uploadType,
        tags: uploadTags.length > 0 ? uploadTags : undefined,
      };

      let response;

      if (filesToUpload.length === 1 && !groupByFolder && !groupAsSingle) {
        // Single file upload
        response = await uploadMutation.mutateAsync({
          file: filesToUpload[0],
          metadata: baseMetadata
        });
      } else {
        // Bulk upload
        const batchMetadata = {
          ...baseMetadata,
          groupBy: groupAsSingle ? 'batch' : (groupByFolder ? 'folder' : 'file'),
          groupDisplayName: groupAsSingle ? groupDisplayName : undefined,
        };

        response = await batchUploadMutation.mutateAsync({
          files: filesToUpload,
          metadata: batchMetadata
        });
      }

      // Notify parent about the new upload operation if it has a progressId
      if (response?.progressId && onCrawlStarted) {
        onCrawlStarted(response.progressId);
      }

      // Upload happens in background - show appropriate message
      const fileCountMsg = filesToUpload.length === 1
        ? filesToUpload[0].name
        : `${filesToUpload.length} files`;
      showToast(`Upload started for ${fileCountMsg}. Processing in background...`, "info");

      resetForm();
      onOpenChange(false);
    } catch (error) {
      // Display the actual error message from backend
      const message = error instanceof Error ? error.message : "Failed to upload document(s)";
      showToast(message, "error");
    }
  };

  const isProcessing = crawlMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Add Knowledge</DialogTitle>
          <DialogDescription>Crawl websites or upload documents to expand your knowledge base.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "crawl" | "upload")}>
          {/* Enhanced Tab Buttons */}
          <div className="grid grid-cols-2 gap-3 p-2 rounded-xl backdrop-blur-md bg-gradient-to-b from-gray-100/30 via-gray-50/20 to-white/40 dark:from-gray-900/30 dark:via-gray-800/20 dark:to-black/40 border border-gray-200/40 dark:border-gray-700/40">
            {/* Crawl Website Tab */}
            <button
              type="button"
              onClick={() => setActiveTab("crawl")}
              className={cn(
                "relative flex items-center justify-center gap-3 px-6 py-4 rounded-lg transition-all duration-300",
                "backdrop-blur-md border-2 font-medium text-sm",
                activeTab === "crawl"
                  ? "bg-gradient-to-b from-cyan-100/70 via-cyan-50/40 to-white/80 dark:from-cyan-900/40 dark:via-cyan-800/25 dark:to-black/50 border-cyan-400/60 text-cyan-700 dark:text-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.25)]"
                  : "bg-gradient-to-b from-white/40 via-white/30 to-white/60 dark:from-gray-800/40 dark:via-gray-800/30 dark:to-black/60 border-gray-300/40 dark:border-gray-600/40 text-gray-600 dark:text-gray-300 hover:border-cyan-300/50 hover:text-cyan-600 dark:hover:text-cyan-400 hover:shadow-[0_0_15px_rgba(34,211,238,0.15)]",
              )}
            >
              {/* Top accent glow for active state */}
              {activeTab === "crawl" && (
                <div className="pointer-events-none absolute inset-x-0 top-0">
                  <div className="mx-2 mt-0.5 h-[2px] rounded-full bg-cyan-500" />
                  <div className="-mt-1 h-8 w-full bg-gradient-to-b from-cyan-500/30 to-transparent blur-md" />
                </div>
              )}
              <Globe className={cn("w-5 h-5", activeTab === "crawl" ? "text-cyan-500" : "text-current")} />
              <div className="flex flex-col items-start gap-0.5">
                <span className="font-semibold">Crawl Website</span>
                <span className="text-xs opacity-80">Scan web pages</span>
              </div>
            </button>

            {/* Upload Document Tab */}
            <button
              type="button"
              onClick={() => setActiveTab("upload")}
              className={cn(
                "relative flex items-center justify-center gap-3 px-6 py-4 rounded-lg transition-all duration-300",
                "backdrop-blur-md border-2 font-medium text-sm",
                activeTab === "upload"
                  ? "bg-gradient-to-b from-purple-100/70 via-purple-50/40 to-white/80 dark:from-purple-900/40 dark:via-purple-800/25 dark:to-black/50 border-purple-400/60 text-purple-700 dark:text-purple-300 shadow-[0_0_20px_rgba(147,51,234,0.25)]"
                  : "bg-gradient-to-b from-white/40 via-white/30 to-white/60 dark:from-gray-800/40 dark:via-gray-800/30 dark:to-black/60 border-gray-300/40 dark:border-gray-600/40 text-gray-600 dark:text-gray-300 hover:border-purple-300/50 hover:text-purple-600 dark:hover:text-purple-400 hover:shadow-[0_0_15px_rgba(147,51,234,0.15)]",
              )}
            >
              {/* Top accent glow for active state */}
              {activeTab === "upload" && (
                <div className="pointer-events-none absolute inset-x-0 top-0">
                  <div className="mx-2 mt-0.5 h-[2px] rounded-full bg-purple-500" />
                  <div className="-mt-1 h-8 w-full bg-gradient-to-b from-purple-500/30 to-transparent blur-md" />
                </div>
              )}
              <Upload className={cn("w-5 h-5", activeTab === "upload" ? "text-purple-500" : "text-current")} />
              <div className="flex flex-col items-start gap-0.5">
                <span className="font-semibold">Upload Document</span>
                <span className="text-xs opacity-80">Add local files</span>
              </div>
            </button>
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
                  placeholder="https://docs.example.com or https://github.com/..."
                  value={crawlUrl}
                  onChange={(e) => setCrawlUrl(e.target.value)}
                  disabled={isProcessing}
                  className="pl-10 h-12 backdrop-blur-md bg-gradient-to-r from-white/60 to-white/50 dark:from-black/60 dark:to-black/50 border-gray-300/60 dark:border-gray-600/60 focus:border-cyan-400/70 focus:shadow-[0_0_20px_rgba(34,211,238,0.15)]"
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Enter the URL of a website you want to crawl for knowledge
              </p>
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
              className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 hover:from-cyan-600 hover:to-cyan-700 backdrop-blur-md border border-cyan-400/50 shadow-[0_0_20px_rgba(6,182,212,0.25)] hover:shadow-[0_0_30px_rgba(6,182,212,0.35)] transition-all duration-200"
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
              <Label className="text-sm font-medium text-gray-900 dark:text-white/90">
                Upload Files
              </Label>

              {/* Hidden file inputs */}
              <div className="relative">
                {/* Multiple files input */}
                <input
                  id="file-upload"
                  type="file"
                  accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                  multiple
                  onChange={(e) => {
                    const list = Array.from(e.target.files || []);
                    setSelectedFiles(list);
                    setSelectedFile(list[0] || null);
                  }}
                  disabled={isProcessing}
                  className="sr-only"
                />

                {/* Single file input */}
                <input
                  id="single-file-upload"
                  type="file"
                  accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setSelectedFile(file);
                    setSelectedFiles(file ? [file] : []);
                    setGroupAsSingle(false);
                    setGroupByFolder(false);
                  }}
                  disabled={isProcessing}
                  className="sr-only"
                />

                {/* Folder input */}
                <input
                  id="folder-upload"
                  type="file"
                  accept=".pdf,.md,.doc,.docx,.txt,.html,.py,.js,.ts,.tsx"
                  multiple
                  webkitdirectory="true"
                  onChange={(e) => {
                    const list = Array.from(e.target.files || []);
                    setSelectedFiles(list);
                    setSelectedFile(list[0] || null);
                    const anyWithRel = list.some((f: any) => !!(f as any).webkitRelativePath);
                    if (anyWithRel) {
                      setGroupAsSingle(true);
                      setGroupByFolder(false);
                      const firstRel = (list[0] as any).webkitRelativePath as string | undefined;
                      if (firstRel) {
                        const topFolder = firstRel.replace(/\\/g, '/').split('/')[0] || 'Batch Upload';
                        if (!groupDisplayName) {
                          setGroupDisplayName(topFolder);
                        }
                      }
                    }
                  }}
                  disabled={isProcessing}
                  className="sr-only"
                />

                {/* Upload buttons */}
                <div className={cn(
                  "relative rounded-xl border-2 border-dashed transition-all duration-200",
                  "backdrop-blur-md bg-gradient-to-b from-white/60 via-white/40 to-white/50 dark:from-black/60 dark:via-black/40 dark:to-black/50",
                  "p-6",
                  selectedFiles.length > 0
                    ? "border-purple-400/70 bg-gradient-to-b from-purple-50/60 to-white/60 dark:from-purple-900/20 dark:to-black/50"
                    : "border-gray-300/60 dark:border-gray-600/60",
                  isProcessing && "opacity-50 cursor-not-allowed",
                )}>
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => document.getElementById('single-file-upload')?.click()}
                      disabled={isProcessing}
                      className="h-12 flex flex-col items-center gap-1"
                    >
                      <Upload className="w-4 h-4" />
                      <span className="text-xs">Single File</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => document.getElementById('file-upload')?.click()}
                      disabled={isProcessing}
                      className="h-12 flex flex-col items-center gap-1"
                    >
                      <Files className="w-4 h-4" />
                      <span className="text-xs">Multiple Files</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => document.getElementById('folder-upload')?.click()}
                      disabled={isProcessing}
                      className="h-12 flex flex-col items-center gap-1"
                    >
                      <Folder className="w-4 h-4" />
                      <span className="text-xs">Folder</span>
                    </Button>
                  </div>

                  {/* File selection display */}
                  <div className="text-center">
                    <div className="font-medium">
                      {selectedFiles.length > 1
                        ? `${selectedFiles[0].name} +${selectedFiles.length - 1} more`
                        : selectedFile
                          ? selectedFile.name
                          : 'No selection yet'}
                    </div>
                    <div className="text-sm opacity-75 mt-1">
                      {selectedFiles.length > 1
                        ? `${selectedFiles.length} items`
                        : selectedFile
                          ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB`
                          : 'Choose single file, multiple files, or entire folder'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Grouping options */}
              {selectedFiles.length > 1 && (
                <div className="space-y-3 p-4 bg-gray-50/50 dark:bg-gray-900/50 rounded-lg">
                  <Label className="text-sm font-medium">Grouping Options</Label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={groupByFolder}
                        onChange={(e) => {
                          setGroupByFolder(e.target.checked);
                          if (e.target.checked) setGroupAsSingle(false);
                        }}
                        className="rounded border-gray-300"
                        disabled={isProcessing}
                      />
                      <span className="text-sm">Group files by top-level folder</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={groupAsSingle}
                        onChange={(e) => {
                          setGroupAsSingle(e.target.checked);
                          if (e.target.checked) setGroupByFolder(false);
                        }}
                        className="rounded border-gray-300"
                        disabled={isProcessing}
                      />
                      <span className="text-sm">Group all files as a single source</span>
                    </label>
                    {groupAsSingle && (
                      <Input
                        placeholder="Source title (optional)"
                        value={groupDisplayName}
                        onChange={(e) => setGroupDisplayName(e.target.value)}
                        disabled={isProcessing}
                        className="mt-2"
                      />
                    )}
                  </div>
                </div>
              )}
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
              disabled={isProcessing || (selectedFiles.length === 0 && !selectedFile)}
              className="w-full bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700 backdrop-blur-md border border-purple-400/50 shadow-[0_0_20px_rgba(147,51,234,0.25)] hover:shadow-[0_0_30px_rgba(147,51,234,0.35)] transition-all duration-200"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  {selectedFiles.length > 1 ? `Upload ${selectedFiles.length} Files` : 'Upload Document'}
                </>
              )}
            </Button>
          </TabsContent>
        </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
};
