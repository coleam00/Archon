/**
 * Knowledge Card component
 * Displays a knowledge item with inline progress and status UI
 * Following the pattern from ProjectCard
 */

import { format } from "date-fns";
import { motion } from "framer-motion";
import { Clock, Code, ExternalLink, File, FileText, Globe } from "lucide-react";
import { useState } from "react";
import { isOptimistic } from "@/features/shared/utils/optimistic";
import { KnowledgeCardProgress } from "../../progress/components/KnowledgeCardProgress";
import type { ActiveOperation } from "../../progress/types";
import { StatPill } from "../../ui/primitives";
import { DataCard, DataCardContent, DataCardFooter, DataCardHeader } from "../../ui/primitives/data-card";
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

  // Determine edge color for DataCard primitive
  const getEdgeColor = (): "cyan" | "purple" | "blue" | "pink" | "red" | "orange" => {
    if (activeOperation) return "cyan";
    if (hasError) return "red";
    if (isProcessing) return "orange";
    if (isTechnical) return isUrl ? "cyan" : "purple";
    return isUrl ? "blue" : "pink";
  };

  // Accent color name for title component
  const getAccentColorName = () => {
    if (activeOperation) return "cyan" as const;
    if (hasError) return "red" as const;
    if (isProcessing) return "yellow" as const;
    if (isTechnical) return isUrl ? ("cyan" as const) : ("purple" as const);
    return isUrl ? ("blue" as const) : ("pink" as const);
  };

  const getSourceIcon = () => {
    if (isUrl) return <Globe className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: Card contains nested interactive elements (buttons, links) - using div to avoid invalid HTML nesting
    <motion.div
      className={cn("relative group cursor-pointer", optimistic && "opacity-80")}
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
      <DataCard
        edgePosition="top"
        edgeColor={getEdgeColor()}
        blur="md"
        className={cn(
          "transition-shadow",
          isHovered && "shadow-[0_0_30px_rgba(6,182,212,0.2)]",
          optimistic && "ring-1 ring-cyan-400/30",
        )}
      >
        <DataCardHeader>
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
                className={[
                  "inline-flex items-center gap-1 text-xs mt-2",
                  "text-gray-600 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors",
                ].join(" ")}
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
        </DataCardHeader>

        <DataCardContent>
          {/* Progress tracking for active operations - using simplified component */}
          {activeOperation && <KnowledgeCardProgress operation={activeOperation} />}
        </DataCardContent>

        <DataCardFooter>
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
        </DataCardFooter>
      </DataCard>
    </motion.div>
  );
};
