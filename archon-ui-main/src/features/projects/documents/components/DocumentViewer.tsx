import { FileText, Code } from "lucide-react";
import { useState } from "react";
import { cn } from "../../../ui/primitives/styles";
import type { ProjectDocument } from "../types";

interface DocumentViewerProps {
  document: ProjectDocument;
}

/**
 * Simple read-only document viewer
 * Displays document content in a reliable way without complex editing
 */
export const DocumentViewer = ({ document }: DocumentViewerProps) => {
  const [isBeautified, setIsBeautified] = useState(true);

  // Check if document has JSON content that can be beautified
  const hasJsonContent = () => {
    if (typeof document.content === "object" && document.content && !("text" in document.content) && !("markdown" in document.content)) {
      return true;
    }
    return false;
  };

  // Extract content for display
  const renderContent = () => {
    if (!document.content) {
      return <p className="text-gray-500 italic">No content available</p>;
    }

    // Handle string content
    if (typeof document.content === "string") {
      return (
        <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300">{document.content}</pre>
      );
    }

    // Handle markdown field
    if ("markdown" in document.content && typeof document.content.markdown === "string") {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300">
            {document.content.markdown}
          </pre>
        </div>
      );
    }

    // Handle text field
    if ("text" in document.content && typeof document.content.text === "string") {
      return (
        <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300">
          {document.content.text}
        </pre>
      );
    }

    // Handle structured content (JSON)
    if (isBeautified) {
      const renderValue = (value: any, key?: string): React.ReactNode => {
        if (value === null || value === undefined) {
          return <span className="text-gray-400 italic">N/A</span>;
        }
        
        if (typeof value === "string") {
          // Check if it's a long text that should be rendered as paragraphs
          if (value.length > 100) {
            return (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                {value.split('\n').map((paragraph, i) => (
                  <p key={i} className="mb-3 text-gray-700 dark:text-gray-300 leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </div>
            );
          }
          return <span className="text-gray-700 dark:text-gray-300">{value}</span>;
        }
        
        if (typeof value === "number") {
          return <span className="text-blue-600 dark:text-blue-400 font-medium">{value}</span>;
        }
        
        if (typeof value === "boolean") {
          return (
            <span className={`font-medium ${value ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {value ? 'Yes' : 'No'}
            </span>
          );
        }
        
        if (Array.isArray(value)) {
          if (value.length === 0) return <span className="text-gray-400 italic">None</span>;
          
          // Render as bullet points for better readability
          return (
            <ul className="space-y-2 mt-2">
              {value.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="text-blue-500 mt-2">•</span>
                  <div className="flex-1 text-gray-700 dark:text-gray-300">
                    {typeof item === "string" ? item : renderValue(item)}
                  </div>
                </li>
              ))}
            </ul>
          );
        }
        
        if (typeof value === "object") {
          const entries = Object.entries(value);
          if (entries.length === 0) return <span className="text-gray-400 italic">Empty</span>;
          
          return (
            <div className="space-y-3 mt-2">
              {entries.map(([k, v]) => (
                <div key={k} className="border-l-2 border-blue-200 dark:border-blue-800 pl-4">
                  <div className="font-medium text-gray-800 dark:text-gray-200 mb-1">
                    {k.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                  </div>
                  <div className="text-sm">{renderValue(v, k)}</div>
                </div>
              ))}
            </div>
          );
        }
        
        return <span className="text-gray-700 dark:text-gray-300">{String(value)}</span>;
      };

      return (
        <div className="prose prose-lg dark:prose-invert max-w-none">
          <div className="space-y-8">
            {Object.entries(document.content).map(([key, value]) => (
              <section key={key} className="not-prose">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6 pb-3 border-b-2 border-blue-200 dark:border-blue-800">
                  {key.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
                </h2>
                <div className="pl-4">
                  {renderValue(value, key)}
                </div>
              </section>
            ))}
          </div>
        </div>
      );
    } else {
      // Raw JSON view
      return (
        <pre className="bg-gray-100 dark:bg-gray-900 p-4 rounded text-sm overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">
          {JSON.stringify(document.content, null, 2)}
        </pre>
      );
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-gray-500" />
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">{document.title}</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Type: {document.document_type || "document"} • Last updated:{" "}
              {new Date(document.updated_at).toLocaleDateString()}
            </p>
          </div>
          
          {/* Beautify toggle for JSON content */}
          {hasJsonContent() && (
            <button
              onClick={() => setIsBeautified(!isBeautified)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm rounded-md border transition-colors",
                "hover:bg-gray-50 dark:hover:bg-gray-800",
                isBeautified
                  ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300"
                  : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
              )}
            >
              <Code className="w-4 h-4" />
              {isBeautified ? "Show Raw JSON" : "Beautify"}
            </button>
          )}
        </div>
        {document.tags && document.tags.length > 0 && (
          <div className="flex gap-2 mt-3">
            {document.tags.map((tag) => (
              <span
                key={tag}
                className={cn(
                  "px-2 py-1 text-xs rounded",
                  "bg-gray-100 dark:bg-gray-800",
                  "text-gray-700 dark:text-gray-300",
                  "border border-gray-300 dark:border-gray-600",
                )}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 bg-white dark:bg-gray-900">{renderContent()}</div>
    </div>
  );
};
