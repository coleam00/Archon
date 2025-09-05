import { FileText, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "../../ui/primitives";
import { cn } from "../../ui/primitives/styles";
import { DocumentCard } from "./components/DocumentCard";
import { DocumentViewer } from "./components/DocumentViewer";
import { useProjectDocuments } from "./hooks";
import type { ProjectDocument } from "./types";

interface DocsTabProps {
  project?: {
    id: string;
    title: string;
    created_at?: string;
    updated_at?: string;
  } | null;
}

/**
 * Read-only documents tab
 * Displays existing documents from the project's JSONB field
 */
export const DocsTab = ({ project }: DocsTabProps) => {
  const projectId = project?.id || "";

  // Fetch documents from project's docs field
  const { data: documents = [], isLoading } = useProjectDocuments(projectId);

  // Document state
  const [selectedDocument, setSelectedDocument] = useState<ProjectDocument | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Auto-select first document when documents load
  useEffect(() => {
    if (documents.length > 0 && !selectedDocument) {
      setSelectedDocument(documents[0]);
    }
  }, [documents, selectedDocument]);

  // Update selected document if it was updated
  useEffect(() => {
    if (selectedDocument && documents.length > 0) {
      const updated = documents.find((d) => d.id === selectedDocument.id);
      if (updated && updated !== selectedDocument) {
        setSelectedDocument(updated);
      }
    }
  }, [documents, selectedDocument]);

  // Filter documents based on search
  const filteredDocuments = documents.filter((doc) => doc.title.toLowerCase().includes(searchQuery.toLowerCase()));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-200px)]">
      {/* Migration Warning Banner */}
      <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="text-yellow-600 dark:text-yellow-400">
            <svg className="w-5 h-5 mt-0.5" fill="currentColor" viewBox="0 0 20 20" aria-label="Warning">
              <title>Warning icon</title>
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
              Project Documents Under Migration
            </h3>
            <p className="text-sm text-yellow-700 dark:text-yellow-400 mt-1">
              Editing and uploading project documents is currently disabled while we migrate to a new storage system.
              <strong className="font-semibold">
                {" "}
                Please backup your existing project documents elsewhere as they will be lost when the migration is
                complete.
              </strong>
            </p>
            <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1">
              Note: This only affects project-specific documents. Your knowledge base documents are safe and unaffected.
            </p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1">
        {/* Left Sidebar - Document List */}
        <div
          className={cn(
            "w-80 flex flex-col",
            "border-r border-gray-200 dark:border-gray-700",
            "bg-gray-50 dark:bg-gray-900",
          )}
        >
          {/* Header */}
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2 text-gray-800 dark:text-white">
              <FileText className="w-5 h-5" />
              Documents (Read-Only)
            </h2>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                type="text"
                placeholder="Search documents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Info message */}
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
              Viewing {documents.length} document{documents.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Document List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {filteredDocuments.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{searchQuery ? "No documents found" : "No documents in this project"}</p>
              </div>
            ) : (
              filteredDocuments.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  document={doc}
                  isActive={selectedDocument?.id === doc.id}
                  onSelect={setSelectedDocument}
                  onDelete={() => {}} // No delete in read-only mode
                />
              ))
            )}
          </div>
        </div>

        {/* Right Content - Document Viewer */}
        <div className="flex-1 bg-white dark:bg-gray-900">
          {selectedDocument ? (
            <DocumentViewer document={selectedDocument} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <FileText className="w-16 h-16 text-gray-300 dark:text-gray-700 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400">
                  {documents.length > 0 ? "Select a document to view" : "No documents available"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
