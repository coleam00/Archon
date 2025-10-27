import { Edit3, Eye, FileText, Save } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button, Card } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import { SimpleTooltip } from "../../../ui/primitives/tooltip";
import type { ProjectDocument } from "../types";

interface DocumentViewerProps {
  document: ProjectDocument;
  onSave?: (documentId: string, content: any) => Promise<void>;
}

/**
 * Simple read-only document viewer
 * Displays document content in a reliable way without complex editing
 */
export const DocumentViewer = ({ document, onSave }: DocumentViewerProps) => {
  const [isEditMode, setIsEditMode] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Get markdown content as string
  const getMarkdownContent = (): string => {
    if (!document.content) return "";

    if (typeof document.content === "string") return document.content;
    if ("markdown" in document.content && typeof document.content.markdown === "string") {
      return document.content.markdown;
    }
    if ("text" in document.content && typeof document.content.text === "string") {
      return document.content.text;
    }
    if ("sections" in document.content && Array.isArray(document.content.sections)) {
      return document.content.sections
        .map((s: any) => `${s.heading ? `# ${s.heading}\n\n` : ""}${s.content || ""}`)
        .join("\n\n");
    }
    return JSON.stringify(document.content, null, 2);
  };

  // Initialize edited content when switching to edit mode
  const handleToggleEdit = () => {
    if (!isEditMode) {
      setEditedContent(getMarkdownContent());
    }
    setIsEditMode(!isEditMode);
    setHasChanges(false);
  };

  const handleContentChange = (value: string) => {
    setEditedContent(value);
    setHasChanges(value !== getMarkdownContent());
  };

  const handleSave = async () => {
    if (!onSave || !hasChanges) return;

    setIsSaving(true);
    try {
      await onSave(document.id, { markdown: editedContent });
      setHasChanges(false);
      setIsEditMode(false);
    } catch (error) {
      console.error("Failed to save document:", error);
    } finally {
      setIsSaving(false);
    }
  };

  // Extract content for display
  const renderContent = () => {
    if (!document.content) {
      return <p className="text-gray-500 dark:text-gray-400 italic">No content available</p>;
    }

    // Handle string content
    if (typeof document.content === "string") {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
            {document.content}
          </pre>
        </div>
      );
    }

    // Handle markdown field
    if ("markdown" in document.content && typeof document.content.markdown === "string") {
      return (
        <div className="markdown-content">
          <ReactMarkdown
            components={{
              h1: ({ node, ...props }) => (
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4 mt-6" {...props} />
              ),
              h2: ({ node, ...props }) => (
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3 mt-5" {...props} />
              ),
              h3: ({ node, ...props }) => (
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 mt-4" {...props} />
              ),
              p: ({ node, ...props }) => (
                <p className="text-sm text-gray-700 dark:text-gray-300 mb-3 leading-relaxed" {...props} />
              ),
              ul: ({ node, ...props }) => (
                <ul
                  className="list-disc list-inside text-sm text-gray-700 dark:text-gray-300 mb-3 space-y-1"
                  {...props}
                />
              ),
              ol: ({ node, ...props }) => (
                <ol
                  className="list-decimal list-inside text-sm text-gray-700 dark:text-gray-300 mb-3 space-y-1"
                  {...props}
                />
              ),
              li: ({ node, ...props }) => <li className="ml-4" {...props} />,
              code: ({ node, ...props }) => (
                <code
                  className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs font-mono text-cyan-600 dark:text-cyan-400"
                  {...props}
                />
              ),
              pre: ({ node, ...props }) => (
                <pre className="bg-gray-100 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto mb-3" {...props} />
              ),
              a: ({ node, ...props }) => <a className="text-cyan-600 dark:text-cyan-400 hover:underline" {...props} />,
              blockquote: ({ node, ...props }) => (
                <blockquote
                  className="border-l-4 border-gray-300 dark:border-gray-700 pl-4 italic text-gray-600 dark:text-gray-400 my-3"
                  {...props}
                />
              ),
            }}
          >
            {document.content.markdown}
          </ReactMarkdown>
        </div>
      );
    }

    // Handle text field
    if ("text" in document.content && typeof document.content.text === "string") {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
            {document.content.text}
          </pre>
        </div>
      );
    }

    // Handle sections array (structured content)
    if ("sections" in document.content && Array.isArray(document.content.sections)) {
      return (
        <div className="space-y-6">
          {document.content.sections.map((section: any, index: number) => (
            <div key={index} className="space-y-2">
              {section.heading && (
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white border-l-4 border-cyan-500 pl-3">
                  {section.heading}
                </h3>
              )}
              {section.content && (
                <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap pl-3">
                  {section.content}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }

    // Fallback: render JSON as formatted text
    return (
      <div className="space-y-4">
        <pre className="bg-gray-100 dark:bg-gray-900 p-4 rounded-lg text-xs overflow-x-auto text-gray-700 dark:text-gray-300">
          {JSON.stringify(document.content, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Metadata Card - Blue glass with bottom edge-lit */}
      <Card
        blur="md"
        transparency="light"
        edgePosition="bottom"
        edgeColor="blue"
        size="md"
        className="overflow-visible"
      >
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          <div className="flex-1">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{document.title}</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Type:{" "}
                <span className="px-2 py-1 text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded">
                  {document.document_type || "document"}
                </span>
              </span>
              {document.updated_at && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Last updated: {new Date(document.updated_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Content Card - Medium blur glass */}
      <Card blur="md" transparency="light" size="lg" className="overflow-visible">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Content</h3>
          <div className="flex items-center gap-2">
            {/* Save button - only show in edit mode with changes */}
            {isEditMode && hasChanges && (
              <SimpleTooltip content={isSaving ? "Saving..." : "Save changes"}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="text-green-600 dark:text-green-400 hover:bg-green-500/10"
                  aria-label="Save document"
                >
                  <Save className={cn("w-4 h-4", isSaving && "animate-pulse")} aria-hidden="true" />
                </Button>
              </SimpleTooltip>
            )}
            {/* View/Edit toggle */}
            <SimpleTooltip content={isEditMode ? "Preview mode" : "Edit mode"}>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleToggleEdit}
                className="text-gray-600 dark:text-gray-400 hover:bg-gray-500/10"
                aria-label={isEditMode ? "Switch to preview mode" : "Switch to edit mode"}
                aria-pressed={isEditMode}
              >
                {isEditMode ? (
                  <Eye className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Edit3 className="w-4 h-4" aria-hidden="true" />
                )}
              </Button>
            </SimpleTooltip>
          </div>
        </div>

        {isEditMode ? (
          <textarea
            value={editedContent}
            onChange={(e) => handleContentChange(e.target.value)}
            className={cn(
              "w-full min-h-[400px] p-4 rounded-lg",
              "bg-white/50 dark:bg-black/30",
              "border border-gray-300 dark:border-gray-700",
              "text-gray-900 dark:text-white font-mono text-sm",
              "focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20",
              "resize-y",
            )}
            placeholder="Enter markdown content..."
          />
        ) : (
          <div className="text-gray-700 dark:text-gray-300">{renderContent()}</div>
        )}
      </Card>
    </div>
  );
};
