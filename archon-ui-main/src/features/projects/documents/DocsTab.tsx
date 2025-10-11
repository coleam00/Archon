import { FileText, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Button, Input } from "../../ui/primitives";
import { AddDocumentModal } from "./components/AddDocumentModal";
import { DocumentCard } from "./components/DocumentCard";
import { DocumentViewer } from "./components/DocumentViewer";
import { useCreateDocument, useDeleteDocument, useProjectDocuments, useUpdateDocument } from "./hooks";
import type { DocumentContent, ProjectDocument } from "./types";

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
  const updateDocumentMutation = useUpdateDocument(projectId);
  const createDocumentMutation = useCreateDocument(projectId);
  const deleteDocumentMutation = useDeleteDocument(projectId);

  // Document state
  const [selectedDocument, setSelectedDocument] = useState<ProjectDocument | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<ProjectDocument | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // Handle document save
  const handleSaveDocument = async (documentId: string, content: DocumentContent) => {
    try {
      await updateDocumentMutation.mutateAsync({
        documentId,
        updates: { content },
      });
    } catch (error) {
      console.error("Failed to save document:", error);
      throw error;
    }
  };

  // Handle add document
  const handleAddDocument = async (title: string, document_type: string) => {
    await createDocumentMutation.mutateAsync({
      title,
      document_type,
      content: { markdown: "# " + title + "\n\nStart writing your document here..." },
      // NOTE: Archon does not have user authentication - this is a single-user local app.
      // "User" is a constant representing the sole user of this Archon instance.
      author: "User",
    });
  };

  // Handle delete document
  const handleDeleteDocument = (doc: ProjectDocument) => {
    setDocumentToDelete(doc);
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    if (!documentToDelete) return;

    await deleteDocumentMutation.mutateAsync(documentToDelete.id);

    // Clear selection if deleted document was selected
    if (selectedDocument?.id === documentToDelete.id) {
      setSelectedDocument(null);
    }

    setShowDeleteModal(false);
    setDocumentToDelete(null);
  };

  const cancelDelete = () => {
    setShowDeleteModal(false);
    setDocumentToDelete(null);
  };

  // Reset state when project changes
  useEffect(() => {
    setSelectedDocument(null);
    setSearchQuery("");
    setShowAddModal(false);
    setShowDeleteModal(false);
    setDocumentToDelete(null);
  }, [projectId]);

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
    <div className="flex h-[600px] gap-6">
      {/* Main Content */}
      {/* Left Sidebar - Document List */}
      <div className="w-64 flex flex-col space-y-4 overflow-visible">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-gray-700 dark:text-gray-300" />
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white">Documents</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddModal(true)}
            className="text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
            aria-label="Add new document"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            aria-label="Search documents"
          />
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          {documents.length} document{documents.length !== 1 ? "s" : ""}
        </p>

        <div className="flex-1 min-h-0">
          <div className="h-full overflow-y-auto space-y-2 p-2 -mx-2">
            {filteredDocuments.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">{searchQuery ? "No documents found" : "No documents in this project"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredDocuments.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    document={doc}
                    isActive={selectedDocument?.id === doc.id}
                    onSelect={setSelectedDocument}
                    onDelete={handleDeleteDocument}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Content - Document Viewer */}
      <div className="flex-1 overflow-y-auto">
        {selectedDocument ? (
          <DocumentViewer document={selectedDocument} onSave={handleSaveDocument} />
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

      {/* Add Document Modal */}
      <AddDocumentModal open={showAddModal} onOpenChange={setShowAddModal} onAdd={handleAddDocument} />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        open={showDeleteModal}
        onOpenChange={(open) => {
          setShowDeleteModal(open);
          if (!open) setDocumentToDelete(null);
        }}
        itemName={documentToDelete?.title ?? ""}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
        type="document"
      />
    </div>
  );
};
