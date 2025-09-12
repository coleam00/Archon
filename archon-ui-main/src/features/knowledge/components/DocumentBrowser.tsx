/**
 * Document Browser Component
 * Shows document chunks and code examples for a knowledge item
 */

import { ChevronDown, ChevronRight, Code, FileText, Search } from "lucide-react";
import { useState } from "react";
import { Input } from "../../ui/primitives";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/primitives/dialog";
import { cn } from "../../ui/primitives/styles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives/tabs";
import { useCodeExamples, useKnowledgeItemChunks } from "../hooks";

interface DocumentBrowserProps {
  sourceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DocumentBrowser: React.FC<DocumentBrowserProps> = ({ sourceId, open, onOpenChange }) => {
  const [activeTab, setActiveTab] = useState<"documents" | "code">("documents");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set());

  const {
    data: chunksData,
    isLoading: chunksLoading,
    isError: chunksError,
    error: chunksErrorObj,
  } = useKnowledgeItemChunks(sourceId);
  const { data: codeData, isLoading: codeLoading, isError: codeError, error: codeErrorObj } = useCodeExamples(sourceId);

  const chunks = chunksData?.chunks || [];
  const codeExamples = codeData?.code_examples || [];

  // Filter chunks based on search
  const filteredChunks = chunks.filter(
    (chunk) =>
      chunk.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      chunk.metadata?.title?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Filter code examples based on search
  const filteredCode = codeExamples.filter((example) => {
    const codeContent = example.code || example.content || "";
    return (
      codeContent.toLowerCase().includes(searchQuery.toLowerCase()) ||
      example.summary?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      example.language?.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  const toggleChunk = (chunkId: string) => {
    setExpandedChunks((prev) => {
      const next = new Set(prev);
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Document Browser</DialogTitle>
          <div className="flex items-center gap-2 mt-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                type="text"
                placeholder="Search documents and code..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 bg-black/30 border-white/10 focus:border-cyan-500/50"
              />
            </div>
          </div>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "documents" | "code")}
          className="flex-1 flex flex-col"
        >
          <TabsList className="">
            <TabsTrigger value="documents" className="data-[state=active]:bg-cyan-500/20">
              <FileText className="w-4 h-4 mr-2" />
              Documents ({filteredChunks.length})
            </TabsTrigger>
            <TabsTrigger value="code" className="data-[state=active]:bg-cyan-500/20">
              <Code className="w-4 h-4 mr-2" />
              Code Examples ({filteredCode.length})
            </TabsTrigger>
          </TabsList>

          {/* Documents Tab */}
          <TabsContent value="documents" className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto">
              {chunksLoading ? (
                <div className="text-center py-8 text-gray-400">Loading documents...</div>
              ) : chunksError ? (
                <div className="text-center py-8 text-red-400">
                  Failed to load documents for source {sourceId}.
                  {chunksErrorObj?.message && ` ${chunksErrorObj.message}`}
                </div>
              ) : filteredChunks.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  {searchQuery ? "No documents match your search" : "No documents available"}
                </div>
              ) : (
                <div className="space-y-3 p-4">
                  {filteredChunks.map((chunk) => {
                    const isExpanded = expandedChunks.has(chunk.id);
                    const preview = chunk.content.substring(0, 200);
                    const needsExpansion = chunk.content.length > 200;

                    return (
                      <div
                        key={chunk.id}
                        className="bg-black/30 rounded-lg border border-white/10 p-4 hover:border-cyan-500/30 transition-colors"
                      >
                        {chunk.metadata?.title && (
                          <h4 className="font-medium text-white/90 mb-2 flex items-center gap-2">
                            {needsExpansion && (
                              <button
                                type="button"
                                onClick={() => toggleChunk(chunk.id)}
                                className="text-gray-400 hover:text-white transition-colors"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4" />
                                ) : (
                                  <ChevronRight className="w-4 h-4" />
                                )}
                              </button>
                            )}
                            {chunk.metadata.title}
                          </h4>
                        )}

                        <div className="text-sm text-gray-300 whitespace-pre-wrap">
                          {isExpanded || !needsExpansion ? (
                            chunk.content
                          ) : (
                            <>
                              {preview}...
                              <button
                                type="button"
                                onClick={() => toggleChunk(chunk.id)}
                                className="ml-2 text-cyan-400 hover:text-cyan-300"
                              >
                                Show more
                              </button>
                            </>
                          )}
                        </div>

                        {chunk.metadata?.tags && chunk.metadata.tags.length > 0 && (
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            {chunk.metadata.tags.map((tag: string) => (
                              <span key={tag} className="px-2 py-1 text-xs border border-white/20 rounded bg-black/20">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          {/* Code Examples Tab */}
          <TabsContent value="code" className="flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto">
              {codeLoading ? (
                <div className="text-center py-8 text-gray-400">Loading code examples...</div>
              ) : codeError ? (
                <div className="text-center py-8 text-red-400">
                  Failed to load code examples for source {sourceId}.
                  {codeErrorObj?.message && ` ${codeErrorObj.message}`}
                </div>
              ) : filteredCode.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  {searchQuery ? "No code examples match your search" : "No code examples available"}
                </div>
              ) : (
                <div className="space-y-3 p-4">
                  {filteredCode.map((example) => (
                    <div
                      key={example.id}
                      className="bg-black/30 rounded-lg border border-white/10 overflow-hidden hover:border-cyan-500/30 transition-colors"
                    >
                      <div className="flex items-center justify-between p-3 border-b border-white/10 bg-black/20">
                        <div className="flex items-center gap-2">
                          <Code className="w-4 h-4 text-cyan-400" />
                          {example.language && (
                            <span className="px-2 py-1 text-xs bg-cyan-500/20 text-cyan-400 rounded">
                              {example.language}
                            </span>
                          )}
                        </div>
                        {example.file_path && <span className="text-xs text-gray-400">{example.file_path}</span>}
                      </div>

                      {example.summary && (
                        <div className="p-3 text-sm text-gray-300 border-b border-white/10">{example.summary}</div>
                      )}

                      <pre className="p-4 text-sm overflow-x-auto">
                        <code
                          className={cn(
                            "text-gray-300",
                            example.language === "javascript" && "language-javascript",
                            example.language === "typescript" && "language-typescript",
                            example.language === "python" && "language-python",
                            example.language === "java" && "language-java",
                          )}
                        >
                          {example.code || example.content || ""}
                        </code>
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
