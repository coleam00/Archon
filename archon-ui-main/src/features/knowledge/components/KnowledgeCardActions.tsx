/**
 * Knowledge Card Actions Component
 * Handles actions for knowledge items (recrawl, delete, etc.)
 * Following the pattern from ProjectCardActions
 */

import { Code, Download, Eye, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Button } from "../../ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/primitives/dropdown-menu";
import { cn } from "../../ui/primitives/styles";

interface KnowledgeCardActionsProps {
  sourceId: string; // Source ID for API calls
  itemTitle?: string; // Title for delete confirmation
  isUrl: boolean;
  hasCodeExamples: boolean;
  onViewDocuments: () => void;
  onViewCodeExamples?: () => void;
  onRefresh?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onExport?: () => void;
}

export const KnowledgeCardActions: React.FC<KnowledgeCardActionsProps> = ({
  sourceId: _sourceId, // Currently unused, may be needed for future features
  itemTitle = "this knowledge item",
  isUrl,
  hasCodeExamples,
  onViewDocuments,
  onViewCodeExamples,
  onRefresh,
  onDelete,
  onExport,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRefresh || !isUrl) return;

    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      // Always reset the refreshing state
      setIsRefreshing(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    setShowDeleteModal(true);
  };

  const handleConfirmDelete = async () => {
    if (!onDelete) return;

    setIsDeleting(true);
    setShowDeleteModal(false);
    try {
      await onDelete();
    } finally {
      // Ensures state is reset even if parent removes the card
      setIsDeleting(false);
    }
  };

  const handleViewDocuments = (e: React.MouseEvent) => {
    e.stopPropagation();
    onViewDocuments();
  };

  const handleViewCodeExamples = (e: React.MouseEvent) => {
    e.stopPropagation();
    onViewCodeExamples?.();
  };

  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    onExport?.();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-8 w-8 p-0 text-gray-400 hover:text-white hover:bg-white/10",
              // Always visible for clearer affordance
              "opacity-100",
              (isRefreshing || isDeleting) && "opacity-100",
            )}
            disabled={isDeleting}
            title={isRefreshing ? "Recrawling..." : "More actions"}
          >
            {isRefreshing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <MoreHorizontal className="w-4 h-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={handleViewDocuments}>
            <Eye className="w-4 h-4 mr-2" />
            View Documents
          </DropdownMenuItem>

          {hasCodeExamples && onViewCodeExamples && (
            <DropdownMenuItem onClick={handleViewCodeExamples}>
              <Code className="w-4 h-4 mr-2" />
              View Code Examples
            </DropdownMenuItem>
          )}

          {isUrl && onRefresh && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleRefresh} disabled={isRefreshing}>
                <RefreshCw className={cn("w-4 h-4 mr-2", isRefreshing && "animate-spin")} />
                {isRefreshing ? "Recrawling..." : "Recrawl"}
              </DropdownMenuItem>
            </>
          )}

          {onExport && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleExport}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </DropdownMenuItem>
            </>
          )}

          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleDelete}
                disabled={isDeleting}
                className="text-red-400 focus:text-red-400"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {isDeleting ? "Deleting..." : "Delete"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteConfirmModal
        itemName={itemTitle}
        type="knowledge"
        open={showDeleteModal}
        onOpenChange={setShowDeleteModal}
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowDeleteModal(false)}
      />
    </>
  );
};
