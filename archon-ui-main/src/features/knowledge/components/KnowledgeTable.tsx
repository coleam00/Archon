/**
 * Knowledge Table Component
 * Table view for knowledge items with Tron styling
 */

import { formatDistanceToNowStrict } from "date-fns";
import { Code, ExternalLink, Eye, FileText, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "../../ui/hooks/useToast";
import { Button } from "../../ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/primitives/dropdown-menu";
import { cn } from "../../ui/primitives/styles";
import { useDeleteKnowledgeItem } from "../hooks";
import type { KnowledgeItem } from "../types";

interface KnowledgeTableProps {
  items: KnowledgeItem[];
  onViewDocument: (sourceId: string) => void;
  onDeleteSuccess: () => void;
}

export const KnowledgeTable: React.FC<KnowledgeTableProps> = ({ items, onViewDocument, onDeleteSuccess }) => {
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const { showToast } = useToast();
  const deleteMutation = useDeleteKnowledgeItem();

  const handleDelete = async (item: KnowledgeItem) => {
    if (!confirm(`Delete "${item.title}"? This action cannot be undone.`)) {
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(item.source_id));
    try {
      await deleteMutation.mutateAsync(item.source_id);
      showToast("Knowledge item deleted successfully", "success");
      onDeleteSuccess();
    } catch (_error) {
      showToast("Failed to delete knowledge item", "error");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.source_id);
        return next;
      });
    }
  };

  const getTypeIcon = (type?: string) => {
    if (type === "technical") {
      return <Code className="w-4 h-4" />;
    }
    return <FileText className="w-4 h-4" />;
  };

  const getTypeColor = (type?: string) => {
    if (type === "technical") {
      return "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";
    }
    return "text-blue-400 bg-blue-500/10 border-blue-500/20";
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Title</th>
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Type</th>
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Source</th>
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Docs</th>
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Examples</th>
            <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Created</th>
            <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isDeleting = deletingIds.has(item.source_id);

            return (
              <tr
                key={item.source_id}
                className={cn(
                  "border-b border-white/5 transition-colors",
                  "hover:bg-white/5",
                  isDeleting && "opacity-50 pointer-events-none",
                )}
              >
                {/* Title */}
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <span className="text-white/90 font-medium truncate max-w-xs">{item.title}</span>
                  </div>
                </td>

                {/* Type */}
                <td className="py-3 px-4">
                  <span
                    className={cn(
                      "px-2 py-1 text-xs rounded inline-flex items-center",
                      getTypeColor(item.metadata?.knowledge_type),
                    )}
                  >
                    {getTypeIcon(item.metadata?.knowledge_type)}
                    <span className="ml-1">{item.metadata?.knowledge_type || "general"}</span>
                  </span>
                </td>

                {/* Source URL */}
                <td className="py-3 px-4">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-cyan-400 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span className="truncate max-w-xs">
                      {(() => {
                        try {
                          return new URL(item.url).hostname;
                        } catch {
                          return item.url;
                        }
                      })()}
                    </span>
                  </a>
                </td>

                {/* Document Count */}
                <td className="py-3 px-4">
                  <div className="flex items-center gap-1 text-sm text-gray-400">
                    <FileText className="w-3.5 h-3.5" />
                    <span className="font-medium text-white/80">
                      {item.document_count || item.metadata?.document_count || 0}
                    </span>
                  </div>
                </td>

                {/* Code Examples Count */}
                <td className="py-3 px-4">
                  <div className="flex items-center gap-1 text-sm text-gray-400">
                    <Code className="w-3.5 h-3.5 text-green-400" />
                    <span className="font-medium text-white/80">
                      {item.code_examples_count || item.metadata?.code_examples_count || 0}
                    </span>
                  </div>
                </td>

                {/* Created Date */}
                <td className="py-3 px-4">
                  <span className="text-sm text-gray-400">
                    {formatDistanceToNowStrict(new Date(item.created_at), { addSuffix: true })}
                  </span>
                </td>

                {/* Actions */}
                <td className="py-3 px-4">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onViewDocument(item.source_id)}
                      className="text-gray-400 hover:text-white hover:bg-white/10"
                    >
                      <Eye className="w-4 h-4" />
                    </Button>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-gray-400 hover:text-white hover:bg-white/10"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onViewDocument(item.source_id)}>
                          <Eye className="w-4 h-4 mr-2" />
                          View Documents
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => handleDelete(item)}
                          className="text-red-400 focus:text-red-400"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
