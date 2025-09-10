/**
 * Enhanced Knowledge Card Component
 * Individual knowledge item card with excellent UX and inline progress
 * Following the pattern from ProjectCard
 */

import { formatDistanceToNowStrict } from "date-fns";
import { motion } from "framer-motion";
import { Briefcase, Clock, Code, ExternalLink, File, FileText, Globe, Loader2, Terminal } from "lucide-react";
import { useState } from "react";
import { cn } from "../../ui/primitives/styles";
import { useDeleteKnowledgeItem, useRefreshKnowledgeItem } from "../hooks";
import { KnowledgeCardProgress } from "../progress/components/KnowledgeCardProgress";
import type { ActiveOperation } from "../progress/types";
import type { KnowledgeItem } from "../types";
import { extractDomain } from "../utils/knowledge-utils";
import { KnowledgeCardActions } from "./KnowledgeCardActions";

interface KnowledgeCardProps {
  item: KnowledgeItem;
  onViewDocument: () => void;
  onViewCodeExamples?: () => void;
  onExport?: () => void;
  onDeleteSuccess: () => void;
  activeOperation?: ActiveOperation;
  onRefreshStarted?: (progressId: string) => void;
}

export const KnowledgeCard: React.FC<KnowledgeCardProps> = ({
  item,
  onViewDocument,
  onViewCodeExamples,
  onExport,
  onDeleteSuccess,
  activeOperation,
  onRefreshStarted,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const deleteMutation = useDeleteKnowledgeItem();
  const refreshMutation = useRefreshKnowledgeItem();

  // Determine card styling based on type and status
  // Check if it's a real URL (not a file:// URL)
  const isUrl =
    (item.source_type === "url" || item.metadata?.source_type === "url") && !item.url?.startsWith("file://");
  // const isFile = item.metadata?.source_type === "file" || item.url?.startsWith('file://'); // Currently unused
  // Check both top-level and metadata for knowledge_type (for compatibility)
  const isTechnical = item.knowledge_type === "technical" || item.metadata?.knowledge_type === "technical";
  const isProcessing = item.status === "processing";
  const hasError = item.status === "error";
  const codeExamplesCount = item.code_examples_count || item.metadata?.code_examples_count || 0;
  const documentCount = item.document_count || item.metadata?.document_count || 0;

  const handleDelete = async () => {
    await deleteMutation.mutateAsync(item.source_id);
    onDeleteSuccess();
  };

  const handleRefresh = async () => {
    const response = await refreshMutation.mutateAsync(item.source_id);

    // Notify parent about the new refresh operation
    if (response?.progressId && onRefreshStarted) {
      onRefreshStarted(response.progressId);
    }
  };

  const getCardGradient = () => {
    if (activeOperation) {
      return "from-cyan-900/30 via-cyan-900/15 to-black/40";
    }
    if (hasError) {
      return "from-red-900/20 via-red-900/10 to-black/30";
    }
    if (isProcessing) {
      return "from-yellow-900/20 via-yellow-900/10 to-black/30";
    }
    if (isTechnical) {
      return isUrl
        ? "from-cyan-900/20 via-cyan-900/10 to-black/30"
        : "from-purple-900/20 via-purple-900/10 to-black/30";
    }
    return isUrl ? "from-blue-900/20 via-blue-900/10 to-black/30" : "from-pink-900/20 via-pink-900/10 to-black/30";
  };

  const getBorderColor = () => {
    if (activeOperation) return "border-cyan-500/50";
    if (hasError) return "border-red-500/30";
    if (isProcessing) return "border-yellow-500/30";
    if (isTechnical) {
      return isUrl ? "border-cyan-500/30" : "border-purple-500/30";
    }
    return isUrl ? "border-blue-500/30" : "border-pink-500/30";
  };

  const getSourceIcon = () => {
    if (isUrl) return <Globe className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  const getTypeLabel = () => {
    if (isTechnical) return "Technical";
    return "Business";
  };

  return (
    <motion.div
      className="relative group cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onViewDocument}
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      <div
        className={cn(
          "relative overflow-hidden transition-all duration-300 rounded-xl",
          "bg-gradient-to-b backdrop-blur-md border",
          getCardGradient(),
          getBorderColor(),
          isHovered && "shadow-[0_0_30px_rgba(6,182,212,0.2)]",
          "min-h-[240px] flex flex-col",
        )}
      >
        {/* Glow effect on hover */}
        {isHovered && (
          <div className="absolute inset-0 opacity-20 pointer-events-none">
            <div className="absolute -inset-[100px] bg-[radial-gradient(circle,rgba(6,182,212,0.4)_0%,transparent_70%)] blur-3xl" />
          </div>
        )}

        {/* Header with Type Badge */}
        <div className="relative p-4 pb-2">
          <div className="flex items-start justify-between gap-2 mb-2">
            {/* Type and Source Badge */}
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium",
                  isUrl ? "bg-cyan-500/10 text-cyan-400" : "bg-purple-500/10 text-purple-400",
                )}
              >
                {getSourceIcon()}
                <span>{isUrl ? "Web Page" : "Document"}</span>
              </div>
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium",
                  isTechnical ? "bg-blue-500/10 text-blue-400" : "bg-pink-500/10 text-pink-400",
                )}
              >
                {isTechnical ? <Terminal className="w-3.5 h-3.5" /> : <Briefcase className="w-3.5 h-3.5" />}
                <span>{getTypeLabel()}</span>
              </div>
            </div>

            {/* Actions */}
            <div
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") e.stopPropagation();
              }}
              role="none"
            >
              <KnowledgeCardActions
                sourceId={item.source_id}
                isUrl={isUrl}
                hasCodeExamples={codeExamplesCount > 0}
                onViewDocuments={onViewDocument}
                onViewCodeExamples={codeExamplesCount > 0 ? onViewCodeExamples : undefined}
                onRefresh={isUrl ? handleRefresh : undefined}
                onDelete={handleDelete}
                onExport={onExport}
              />
            </div>
          </div>

          {/* Title */}
          <h3 className="text-base font-semibold text-white/90 line-clamp-2 mb-2">{item.title}</h3>

          {/* URL/Source */}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-cyan-400 transition-colors mt-2"
            >
              <ExternalLink className="w-3 h-3" />
              <span className="truncate">
                {item.url.startsWith("file://") ? item.url.replace("file://", "") : extractDomain(item.url)}
              </span>
            </a>
          )}
        </div>

        {/* Spacer to push footer to bottom */}
        <div className="flex-1" />

        {/* Inline Progress - Show active operation if exists */}
        {activeOperation && (
          <div className="px-4 pb-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-cyan-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="capitalize">{activeOperation.status.replace(/_/g, " ")}</span>
              </div>
              <span className="text-cyan-400 font-medium">{Math.round(activeOperation.progress)}%</span>
            </div>
            <div className="h-1 bg-black/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all duration-300"
                style={{ width: `${activeOperation.progress}%` }}
              />
            </div>
            {activeOperation.message && <p className="text-xs text-gray-400 truncate">{activeOperation.message}</p>}
          </div>
        )}

        {/* Progress tracking for active operations */}
        {activeOperation && <KnowledgeCardProgress progressId={activeOperation.progressId} isActive={true} />}

        {/* Fixed Footer with Stats */}
        <div className="px-4 py-3 bg-black/30 border-t border-white/10">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-gray-400">
                <FileText className="w-3.5 h-3.5" />
                <span className="font-medium text-white/80">{documentCount}</span>
                <span className="text-gray-500">docs</span>
              </div>
              <div className="flex items-center gap-1 text-gray-400">
                <Code className="w-3.5 h-3.5 text-green-400" />
                <span className="font-medium text-white/80">{codeExamplesCount}</span>
                <span className="text-gray-500">examples</span>
              </div>
            </div>
            <div className="flex items-center gap-1 text-gray-500">
              <Clock className="w-3 h-3" />
              <span className="text-xs">
                {formatDistanceToNowStrict(new Date(item.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
