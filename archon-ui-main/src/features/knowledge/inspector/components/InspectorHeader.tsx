/**
 * Inspector Header Component
 * Displays item metadata and badges
 */

import { formatDistanceToNow } from "date-fns";
import { Briefcase, Calendar, File, Globe, Terminal } from "lucide-react";
import { cn } from "../../../ui/primitives/styles";
import type { KnowledgeItem } from "../../types";

interface InspectorHeaderProps {
  item: KnowledgeItem;
  viewMode: "documents" | "code";
  onViewModeChange: (mode: "documents" | "code") => void;
  documentCount: number;
  codeCount: number;
  filteredDocumentCount: number;
  filteredCodeCount: number;
}

export const InspectorHeader: React.FC<InspectorHeaderProps> = ({
  item,
  viewMode,
  onViewModeChange,
  documentCount,
  codeCount,
  filteredDocumentCount,
  filteredCodeCount,
}) => {
  return (
    <div className="px-6 py-4 border-b border-white/10">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h2 className="text-xl font-semibold text-white mb-2">{item.title}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {/* Source Type Badge */}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                item.source_type === "url"
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                  : "bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20",
              )}
            >
              {item.source_type === "url" ? (
                <>
                  <Globe className="w-3.5 h-3.5" />
                  Web
                </>
              ) : (
                <>
                  <File className="w-3.5 h-3.5" />
                  File
                </>
              )}
            </span>

            {/* Knowledge Type Badge */}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                item.knowledge_type === "technical"
                  ? "bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20"
                  : "bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20",
              )}
            >
              {item.knowledge_type === "technical" ? (
                <>
                  <Terminal className="w-3.5 h-3.5" />
                  Technical
                </>
              ) : (
                <>
                  <Briefcase className="w-3.5 h-3.5" />
                  Business
                </>
              )}
            </span>

            {/* URL */}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-cyan-400 hover:text-cyan-300 truncate max-w-xs"
              >
                {item.url}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => onViewModeChange("documents")}
          className={cn(
            "pb-2 px-1 text-sm font-medium border-b-2 transition-colors",
            viewMode === "documents"
              ? "text-cyan-400 border-cyan-400"
              : "text-gray-500 border-transparent hover:text-gray-300",
          )}
        >
          Documents ({documentCount})
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("code")}
          className={cn(
            "pb-2 px-1 text-sm font-medium border-b-2 transition-colors",
            viewMode === "code"
              ? "text-cyan-400 border-cyan-400"
              : "text-gray-500 border-transparent hover:text-gray-300",
          )}
        >
          Code Examples ({codeCount})
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span>
            Showing{" "}
            {viewMode === "documents"
              ? `${filteredDocumentCount} of ${documentCount}`
              : `${filteredCodeCount} of ${codeCount}`}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>
    </div>
  );
};
