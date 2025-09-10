/**
 * Content Viewer Component
 * Displays the selected document or code content
 */

import { Check, Code, Copy, FileText, Layers } from "lucide-react";
import { Button } from "../../../ui/primitives";
import type { InspectorSelectedItem } from "../../types";

interface ContentViewerProps {
  selectedItem: InspectorSelectedItem | null;
  onCopy: (text: string, id: string) => void;
  copiedId: string | null;
}

export const ContentViewer: React.FC<ContentViewerProps> = ({ selectedItem, onCopy, copiedId }) => {
  if (!selectedItem) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <Layers className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="text-sm">Select an item to view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Content Header */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          {selectedItem.type === "document" ? (
            <>
              <FileText className="w-5 h-5 text-cyan-400" />
              <div>
                <h4 className="text-sm font-medium text-white/90">
                  {selectedItem.metadata && "title" in selectedItem.metadata
                    ? selectedItem.metadata.title || "Document"
                    : "Document"}
                </h4>
                {selectedItem.metadata && "section" in selectedItem.metadata && selectedItem.metadata.section && (
                  <p className="text-xs text-gray-500">{selectedItem.metadata.section}</p>
                )}
              </div>
            </>
          ) : (
            <>
              <Code className="w-5 h-5 text-green-400" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-green-500/10 text-green-400 text-xs font-mono rounded">
                    {selectedItem.type === "code" && selectedItem.metadata && "language" in selectedItem.metadata
                      ? selectedItem.metadata.language || "unknown"
                      : "unknown"}
                  </span>
                  {selectedItem.type === "code" &&
                    selectedItem.metadata &&
                    "file_path" in selectedItem.metadata &&
                    selectedItem.metadata.file_path && (
                      <span className="text-xs text-gray-500 font-mono">{selectedItem.metadata.file_path}</span>
                    )}
                </div>
                {selectedItem.type === "code" &&
                  selectedItem.metadata &&
                  "summary" in selectedItem.metadata &&
                  selectedItem.metadata.summary && (
                    <p className="text-xs text-gray-400 mt-1">{selectedItem.metadata.summary}</p>
                  )}
              </div>
            </>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onCopy(selectedItem.content, selectedItem.id)}
          className="text-gray-400 hover:text-white"
        >
          {copiedId === selectedItem.id ? (
            <>
              <Check className="w-4 h-4 text-green-400 mr-1.5" />
              <span className="text-xs">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-4 h-4 mr-1.5" />
              <span className="text-xs">Copy</span>
            </>
          )}
        </Button>
      </div>

      {/* Content Body */}
      <div className="flex-1 overflow-y-auto min-h-0 p-6 scrollbar-thin">
        {selectedItem.type === "document" ? (
          <div className="prose prose-invert max-w-none">
            <pre className="whitespace-pre-wrap text-sm text-gray-300 font-sans">{selectedItem.content}</pre>
          </div>
        ) : (
          <pre className="bg-black/30 border border-white/10 rounded-lg p-4 overflow-x-auto">
            <code className="text-sm text-gray-300 font-mono">{selectedItem.content}</code>
          </pre>
        )}
      </div>

      {/* Content Footer */}
      {selectedItem.metadata?.relevance_score != null && (
        <div className="p-3 border-t border-white/10 text-xs text-gray-500 flex-shrink-0">
          Relevance Score: {(selectedItem.metadata.relevance_score * 100).toFixed(0)}%
        </div>
      )}
    </div>
  );
};
