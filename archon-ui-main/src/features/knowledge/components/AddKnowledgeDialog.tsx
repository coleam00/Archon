/**
 * Add Knowledge Dialog Component
 * Modal for crawling URLs or uploading documents
 */

import { Globe, Loader2, Upload } from "lucide-react";
import { useId, useState } from "react";
import { useToast } from "../../ui/hooks/useToast";
import { Button, Input, Label } from "../../ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/primitives/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives/tabs";
import { useCrawlUrl, useUploadDocument } from "../hooks";
import type { CrawlRequest, UploadMetadata } from "../types";

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
  const typeId = useId();
  const depthId = useId();
  const tagsId = useId();
  const fileId = useId();
  const uploadTypeId = useId();
  const uploadTagsId = useId();

  // Crawl form state
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawlType, setCrawlType] = useState<"technical" | "business">("technical");
  const [maxDepth, setMaxDepth] = useState("2");
  const [tags, setTags] = useState("");

  // Upload form state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadType, setUploadType] = useState<"technical" | "business">("technical");
  const [uploadTags, setUploadTags] = useState("");

  const resetForm = () => {
    setCrawlUrl("");
    setCrawlType("technical");
    setMaxDepth("2");
    setTags("");
    setSelectedFile(null);
    setUploadType("technical");
    setUploadTags("");
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
        tags: tags ? tags.split(",").map((t) => t.trim()) : undefined,
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
    if (!selectedFile) {
      showToast("Please select a file to upload", "error");
      return;
    }

    try {
      const metadata: UploadMetadata = {
        knowledge_type: uploadType,
        tags: uploadTags ? uploadTags.split(",").map((t) => t.trim()) : undefined,
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
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="crawl" className="data-[state=active]:bg-cyan-500/20">
              <Globe className="w-4 h-4 mr-2" />
              Crawl Website
            </TabsTrigger>
            <TabsTrigger value="upload" className="data-[state=active]:bg-cyan-500/20">
              <Upload className="w-4 h-4 mr-2" />
              Upload Document
            </TabsTrigger>
          </TabsList>

          {/* Crawl Tab */}
          <TabsContent value="crawl" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor={urlId}>Website URL</Label>
              <Input
                id={urlId}
                type="url"
                placeholder="https://example.com"
                value={crawlUrl}
                onChange={(e) => setCrawlUrl(e.target.value)}
                disabled={isProcessing}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor={typeId}>Knowledge Type</Label>
                <Select value={crawlType} onValueChange={(v) => setCrawlType(v as "technical" | "business")}>
                  <SelectTrigger id={typeId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="technical">Technical</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor={depthId}>Max Depth</Label>
                <Select value={maxDepth} onValueChange={setMaxDepth}>
                  <SelectTrigger id={depthId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 level</SelectItem>
                    <SelectItem value="2">2 levels</SelectItem>
                    <SelectItem value="3">3 levels</SelectItem>
                    <SelectItem value="5">5 levels</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor={tagsId}>Tags (comma-separated)</Label>
              <Input
                id={tagsId}
                placeholder="documentation, api, guide"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                disabled={isProcessing}
              />
            </div>

            <Button
              onClick={handleCrawl}
              disabled={isProcessing || !crawlUrl}
              className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700"
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
          <TabsContent value="upload" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor={fileId}>Document File</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={fileId}
                  type="file"
                  accept=".txt,.md,.pdf,.doc,.docx"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  disabled={isProcessing}
                  className="flex-1"
                />
              </div>
              {selectedFile && (
                <p className="text-sm text-gray-400">
                  Selected: {selectedFile.name} ({Math.round(selectedFile.size / 1024)} KB)
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor={uploadTypeId}>Knowledge Type</Label>
              <Select value={uploadType} onValueChange={(v) => setUploadType(v as "technical" | "business")}>
                <SelectTrigger id={uploadTypeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="technical">Technical</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor={uploadTagsId}>Tags (comma-separated)</Label>
              <Input
                id={uploadTagsId}
                placeholder="documentation, manual, reference"
                value={uploadTags}
                onChange={(e) => setUploadTags(e.target.value)}
                disabled={isProcessing}
              />
            </div>

            <Button
              onClick={handleUpload}
              disabled={isProcessing || !selectedFile}
              className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700"
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
    </Dialog>
  );
};
