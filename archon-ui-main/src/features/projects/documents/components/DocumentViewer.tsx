import { FileText } from "lucide-react";
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
    return (
      <div className="space-y-4">
        {Object.entries(document.content).map(([key, value]) => (
          <div key={key} className="border-l-2 border-gray-300 dark:border-gray-700 pl-4">
            <h3 className="font-semibold text-gray-700 dark:text-gray-300 mb-2">
              {key.replace(/_/g, " ").charAt(0).toUpperCase() + key.replace(/_/g, " ").slice(1)}
            </h3>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {typeof value === "string" ? (
                <p>{value}</p>
              ) : Array.isArray(value) ? (
                <ul className="list-disc pl-5">
                  {value.map((item, i) => (
                    <li key={`${key}-${typeof item === "object" ? JSON.stringify(item) : String(item)}-${i}`}>
                      {typeof item === "object" ? JSON.stringify(item, null, 2) : String(item)}
                    </li>
                  ))}
                </ul>
              ) : (
                <pre className="bg-gray-100 dark:bg-gray-900 p-2 rounded text-xs overflow-x-auto">
                  {JSON.stringify(value, null, 2)}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>
    );
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
