/**
 * Content Viewer Component
 * Displays the selected document or code content
 */

import { Check, Code, Copy, FileText, Layers } from "lucide-react";
import Prism from "prismjs";
import ReactMarkdown from "react-markdown";
import { Button } from "../../../ui/primitives";
import type { InspectorSelectedItem } from "../../types";

// Import Prism theme and languages
import "prismjs/themes/prism-tomorrow.css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";

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

  // Highlight code with Prism
  const highlightCode = (code: string, language?: string): string => {
    try {
      // Escape HTML entities FIRST per Prism documentation requirement
      // Prism expects pre-escaped input to prevent XSS
      const escaped = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      const lang = language?.toLowerCase() || "javascript";
      const grammar = Prism.languages[lang] || Prism.languages.javascript;
      return Prism.highlight(escaped, grammar, lang);
    } catch (error) {
      console.error("Prism highlighting failed:", error);
      // Return escaped code on error
      return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  };

  // Strip leading/trailing backticks from document content
  const stripOuterBackticks = (content: string) => {
    let cleaned = content.trim();

    // Remove opening triple backticks (with optional language identifier)
    if (cleaned.startsWith("```")) {
      const firstNewline = cleaned.indexOf("\n");
      if (firstNewline > 0) {
        cleaned = cleaned.substring(firstNewline + 1);
      }
    }

    // Remove closing triple backticks
    if (cleaned.endsWith("```")) {
      const lastBackticks = cleaned.lastIndexOf("\n```");
      if (lastBackticks > 0) {
        cleaned = cleaned.substring(0, lastBackticks);
      } else {
        cleaned = cleaned.substring(0, cleaned.length - 3);
      }
    }

    return cleaned.trim();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Content Header - Fixed with proper overflow handling */}
      <div className="p-4 border-b border-white/10 flex items-center gap-3 flex-shrink-0">
        {/* Icon and Metadata - Allow to grow and shrink with min-w-0 for proper truncation */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Icon - Fixed size, no shrink */}
          <div className="flex-shrink-0">
            {selectedItem.type === "document" ? (
              <FileText className="w-5 h-5 text-cyan-400" />
            ) : (
              <Code className="w-5 h-5 text-green-400" />
            )}
          </div>

          {/* Metadata Content - Can shrink with proper overflow */}
          <div className="min-w-0 flex-1">
            {selectedItem.type === "document" ? (
              <>
                <h4 className="text-sm font-medium text-white/90 truncate">
                  {selectedItem.metadata && "title" in selectedItem.metadata
                    ? selectedItem.metadata.title || "Document"
                    : "Document"}
                </h4>
                {selectedItem.metadata && "section" in selectedItem.metadata && selectedItem.metadata.section && (
                  <p className="text-xs text-gray-500 truncate">{selectedItem.metadata.section}</p>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={[
                      "px-2 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400",
                      "text-xs font-mono rounded flex-shrink-0",
                    ].join(" ")}
                  >
                    {selectedItem.type === "code" && selectedItem.metadata && "language" in selectedItem.metadata
                      ? selectedItem.metadata.language || "unknown"
                      : "unknown"}
                  </span>
                  {selectedItem.type === "code" &&
                    selectedItem.metadata &&
                    "file_path" in selectedItem.metadata &&
                    selectedItem.metadata.file_path && (
                      <span className="text-xs text-gray-500 font-mono truncate min-w-0">
                        {selectedItem.metadata.file_path}
                      </span>
                    )}
                </div>
                {selectedItem.type === "code" &&
                  selectedItem.metadata &&
                  "summary" in selectedItem.metadata &&
                  selectedItem.metadata.summary && (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-2">{selectedItem.metadata.summary}</p>
                  )}
              </>
            )}
          </div>
        </div>

        {/* Copy Button - Never shrinks, always visible */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onCopy(selectedItem.content, selectedItem.id)}
          className="text-gray-400 hover:text-white flex-shrink-0"
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
          <div className="prose prose-invert prose-sm max-w-none prose-headings:text-cyan-400 prose-a:text-cyan-400 prose-code:text-purple-400 prose-strong:text-white prose-pre:bg-black/30 prose-pre:border prose-pre:border-white/10">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-4 leading-relaxed">{children}</p>,
                h1: ({ children }) => <h1 className="text-xl font-bold mb-3 mt-6">{children}</h1>,
                h2: ({ children }) => <h2 className="text-lg font-bold mb-3 mt-5">{children}</h2>,
                h3: ({ children }) => <h3 className="text-base font-semibold mb-2 mt-4">{children}</h3>,
                ul: ({ children }) => <ul className="list-disc list-inside mb-4 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside mb-4 space-y-1">{children}</ol>,
                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                code: ({ children }) => <code className="px-1.5 py-0.5 rounded bg-black/30">{children}</code>,
              }}
            >
              {stripOuterBackticks(selectedItem.content || "No content available")}
            </ReactMarkdown>
          </div>
        ) : (
          (() => {
            // Extract language once
            const language =
              selectedItem.metadata && "language" in selectedItem.metadata
                ? selectedItem.metadata.language || "javascript"
                : "javascript";

            return (
              <div className="relative">
                <pre
                  className={[
                    "bg-black/30 dark:bg-black/30 border border-cyan-500/10 rounded-lg p-4",
                    "overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent",
                  ].join(" ")}
                >
                  <code
                    className={`language-${language} font-mono text-sm leading-relaxed`}
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(selectedItem.content || "// No code content available", language),
                    }}
                  />
                </pre>
              </div>
            );
          })()
        )}
      </div>

      {/* Content Footer - Show metadata */}
      <div className="border-t border-white/10 flex-shrink-0">
        <div className="px-4 py-3 flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-4">
            {selectedItem.metadata?.relevance_score != null && (
              <span>
                Relevance:{" "}
                <span className="text-cyan-400">{(selectedItem.metadata.relevance_score * 100).toFixed(0)}%</span>
              </span>
            )}
            {selectedItem.type === "document" &&
              selectedItem.metadata &&
              "url" in selectedItem.metadata &&
              selectedItem.metadata.url && (
                <a
                  href={selectedItem.metadata.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:text-cyan-300 transition-colors underline"
                >
                  View Source
                </a>
              )}
          </div>
          <span className="text-gray-600">{selectedItem.type === "document" ? "Document Chunk" : "Code Example"}</span>
        </div>
      </div>
    </div>
  );
};
