/**
 * Knowledge Table Component
 * Table view for knowledge items with Tron styling
 */

import { formatDistanceToNowStrict } from "date-fns";
import { Code, ExternalLink, Eye, FileText, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/features/shared/hooks/useToast";
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
      return "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400";
    }
    return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
  };

  const getHostname = (url: string): string => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  const isSafeProtocol = (url: string): boolean => {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  };

  const formatCreatedDate = (dateString: string): string => {
    try {
      const date = new Date(dateString);
      if (Number.isNaN(date.getTime())) {
        return "N/A";
      }
      return formatDistanceToNowStrict(date, { addSuffix: true });
    } catch {
      return "N/A";
    }
  };

  return (
    <div className="w-full">
      <div className="overflow-x-auto scrollbar-hide">
        <table className="w-full">
          <thead>
            <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Title</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Type</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Source</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Docs</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Examples</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Created</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-700 dark:text-gray-300">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const isDeleting = deletingIds.has(item.source_id);

              return (
                <tr
                  key={item.source_id}
                  className={cn(
                    "group transition-all duration-200",
                    index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
                    "border-b border-gray-200 dark:border-gray-800",
                    isDeleting && "opacity-50 pointer-events-none",
                  )}
                >
                  {/* Title */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-900 dark:text-white truncate max-w-xs inline-block">
                        {item.title}
                      </span>
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
                  <td className="py-3 px-4 text-sm text-gray-700 dark:text-gray-300 max-w-xs truncate">
                    {isSafeProtocol(item.url) ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span className="truncate inline-block">{getHostname(item.url)}</span>
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span className="truncate inline-block">{getHostname(item.url)}</span>
                      </span>
                    )}
                  </td>

                  {/* Document Count */}
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {item.document_count || item.metadata?.document_count || 0}
                  </td>

                  {/* Code Examples Count */}
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {item.code_examples_count || item.metadata?.code_examples_count || 0}
                  </td>

                  {/* Created Date */}
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {formatCreatedDate(item.created_at)}
                  </td>

                  {/* Actions */}
                  <td className="py-3 px-4">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onViewDocument(item.source_id)}
                        className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
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
                            className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
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
    </div>
  );
};
