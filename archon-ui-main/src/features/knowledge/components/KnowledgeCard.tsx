/**
 * Knowledge Card component
 * Displays a knowledge item with inline progress and status UI
 * Following the pattern from ProjectCard
 */

import { format } from "date-fns";
import { motion } from "framer-motion";
import { Clock, Code, ExternalLink, File, FileText, Globe } from "lucide-react";
import { useState } from "react";
import { KnowledgeCardProgress } from "../../progress/components/KnowledgeCardProgress";
import type { ActiveOperation } from "../../progress/types";
import { isOptimistic } from "@/features/shared/utils/optimistic";
import { StatPill } from "../../ui/primitives";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { cn } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";
import { useDeleteKnowledgeItem, useRefreshKnowledgeItem } from "../hooks";
import type { KnowledgeItem } from "../types";
import { extractDomain } from "../utils/knowledge-utils";
import { KnowledgeCardActions } from "./KnowledgeCardActions";
import { KnowledgeCardTags } from "./KnowledgeCardTags";
import { KnowledgeCardTitle } from "./KnowledgeCardTitle";
import { KnowledgeCardType } from "./KnowledgeCardType";

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

  // Check if item is optimistic
  const optimistic = isOptimistic(item);

  // Determine card styling based on type and status
  // Check if it's a real URL (not a file:// URL)
  // Prioritize top-level source_type over metadata source_type
  const sourceType = item.source_type || item.metadata?.source_type;
  const isUrl = sourceType === "url" && !item.url?.startsWith("file://");
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
    // Prevent double-clicking refresh while a refresh is already in progress
    if (refreshMutation.isPending) return;

    const response = await refreshMutation.mutateAsync(item.source_id);

    // Notify parent about the new refresh operation
    if (response?.progressId && onRefreshStarted) {
      onRefreshStarted(response.progressId);
    }
  };

  const getCardGradient = () => {
    if (activeOperation) {
      return "from-cyan-100/60 via-cyan-50/30 to-white/70 dark:from-cyan-900/30 dark:via-cyan-900/15 dark:to-black/40";
    }
    if (hasError) {
      return "from-red-100/50 via-red-50/25 to-white/60 dark:from-red-900/20 dark:via-red-900/10 dark:to-black/30";
    }
    if (isProcessing) {
      return "from-yellow-100/50 via-yellow-50/25 to-white/60 dark:from-yellow-900/20 dark:via-yellow-900/10 dark:to-black/30";
    }
    if (isTechnical) {
      return isUrl
        ? "from-cyan-100/50 via-cyan-50/25 to-white/60 dark:from-cyan-900/20 dark:via-cyan-900/10 dark:to-black/30"
        : "from-purple-100/50 via-purple-50/25 to-white/60 dark:from-purple-900/20 dark:via-purple-900/10 dark:to-black/30";
    }
    return isUrl
      ? "from-blue-100/50 via-blue-50/25 to-white/60 dark:from-blue-900/20 dark:via-blue-900/10 dark:to-black/30"
      : "from-pink-100/50 via-pink-50/25 to-white/60 dark:from-pink-900/20 dark:via-pink-900/10 dark:to-black/30";
  };

  const getBorderColor = () => {
    if (activeOperation) return "border-cyan-600/40 dark:border-cyan-500/50";
    if (hasError) return "border-red-600/30 dark:border-red-500/30";
    if (isProcessing) return "border-yellow-600/30 dark:border-yellow-500/30";
    if (isTechnical) {
      return isUrl ? "border-cyan-600/30 dark:border-cyan-500/30" : "border-purple-600/30 dark:border-purple-500/30";
    }
    return isUrl ? "border-blue-600/30 dark:border-blue-500/30" : "border-pink-600/30 dark:border-pink-500/30";
  };

  // Accent color used for the top glow bar
  const getAccentColorName = () => {
    if (activeOperation) return "cyan" as const;
    if (hasError) return "red" as const;
    if (isProcessing) return "yellow" as const;
    if (isTechnical) return isUrl ? ("cyan" as const) : ("purple" as const);
    return isUrl ? ("blue" as const) : ("pink" as const);
  };

  const accent = (() => {
    const name = getAccentColorName();
    switch (name) {
      case "cyan":
        return { bar: "bg-cyan-500", smear: "from-cyan-500/25" };
      case "purple":
        return { bar: "bg-purple-500", smear: "from-purple-500/25" };
      case "blue":
        return { bar: "bg-blue-500", smear: "from-blue-500/25" };
      case "pink":
        return { bar: "bg-pink-500", smear: "from-pink-500/25" };
      case "red":
        return { bar: "bg-red-500", smear: "from-red-500/25" };
      case "yellow":
        return { bar: "bg-yellow-400", smear: "from-yellow-400/25" };
      default:
        return { bar: "bg-cyan-500", smear: "from-cyan-500/25" };
    }
  })();

  const getSourceIcon = () => {
    if (isUrl) return <Globe className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: Card contains nested interactive elements (buttons, links) - using div to avoid invalid HTML nesting
    <motion.div
      className="relative group cursor-pointer"
      role="button"
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onViewDocument}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onViewDocument();
        }
      }}
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
          optimistic && "opacity-80 ring-1 ring-cyan-400/30",
        )}
      >
        {/* Top accent glow tied to type (does not change size) */}
        <div className="pointer-events-none absolute inset-x-0 top-0">
          {/* Hairline highlight */}
          <div className={cn("mx-1 mt-0.5 h-[2px] rounded-full", accent.bar)} />
          {/* Soft glow smear fading downward */}
          <div className={cn("-mt-1 h-8 w-full bg-gradient-to-b to-transparent blur-md", accent.smear)} />
        </div>
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
              <SimpleTooltip content={isUrl ? "Content from a web page" : "Uploaded document"}>
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium",
                    isUrl
                      ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-400"
                      : "bg-purple-100 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400",
                  )}
                >
                  {getSourceIcon()}
                  <span>{isUrl ? "Web Page" : "Document"}</span>
                </div>
              </SimpleTooltip>
              <KnowledgeCardType sourceId={item.source_id} knowledgeType={item.knowledge_type} />
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
                itemTitle={item.title}
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
          <div className="mb-2">
            <KnowledgeCardTitle
              sourceId={item.source_id}
              title={item.title}
              description={item.metadata?.description}
              accentColor={getAccentColorName()}
            />
            <OptimisticIndicator isOptimistic={optimistic} className="mt-2" />
          </div>

          {/* URL/Source */}
          {item.url &&
            (isUrl ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors mt-2"
              >
                <ExternalLink className="w-3 h-3" />
                <span className="truncate">{extractDomain(item.url)}</span>
              </a>
            ) : (
              <div className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 mt-2">
                <FileText className="w-3 h-3" />
                <span className="truncate">{item.url.replace("file://", "")}</span>
              </div>
            ))}

          {/* Tags */}
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
              }
            }}
            role="none"
            className="mt-2"
          >
            <KnowledgeCardTags sourceId={item.source_id} tags={item.metadata?.tags || []} />
          </div>
        </div>

        {/* Spacer to push footer to bottom */}
        <div className="flex-1" />

        {/* Progress tracking for active operations - using simplified component */}
        {activeOperation && <KnowledgeCardProgress operation={activeOperation} />}

        {/* Fixed Footer with Stats */}
        <div className="px-4 py-3 bg-gray-100/50 dark:bg-black/30 border-t border-gray-200/50 dark:border-white/10">
          <div className="flex items-center justify-between text-xs">
            {/* Left: date */}
            <div className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
              <Clock className="w-3 h-3" />
              <span className="text-xs">
                {(() => {
                  const updated = item.updated_at || item.created_at;
                  try {
                    return `Updated: ${format(new Date(updated), "M/d/yyyy")}`;
                  } catch {
                    return `Updated: ${new Date(updated).toLocaleDateString()}`;
                  }
                })()}
              </span>
            </div>
            {/* Right: pills */}
            <div className="flex items-center gap-2">
              <SimpleTooltip
                content={`${documentCount} document${documentCount !== 1 ? "s" : ""} indexed - Click to view`}
              >
                <div
                  className="cursor-pointer hover:scale-105 transition-transform"
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewDocument();
                  }}
                >
                  <StatPill
                    color="orange"
                    value={documentCount}
                    size="sm"
                    aria-label="Documents count"
                    icon={<FileText className="w-3.5 h-3.5" />}
                  />
                </div>
              </SimpleTooltip>
              <SimpleTooltip
                content={`${codeExamplesCount} code example${codeExamplesCount !== 1 ? "s" : ""} extracted - ${onViewCodeExamples ? "Click to view" : "No examples available"}`}
              >
                <div
                  className={cn("transition-transform", onViewCodeExamples && "cursor-pointer hover:scale-105")}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onViewCodeExamples) {
                      onViewCodeExamples();
                    }
                  }}
                >
                  <StatPill
                    color="blue"
                    value={codeExamplesCount}
                    size="sm"
                    aria-label="Code examples count"
                    icon={<Code className="w-3.5 h-3.5" />}
                  />
                </div>
              </SimpleTooltip>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
};
