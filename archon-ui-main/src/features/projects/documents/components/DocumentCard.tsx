import {
  BookOpen,
  Briefcase,
  Clipboard,
  Code,
  Database,
  FileCode,
  FileText,
  Info,
  Rocket,
  Trash2,
  Users,
} from "lucide-react";
import type React from "react";
import { memo, useCallback, useState } from "react";
import { copyToClipboard } from "../../../shared/utils/clipboard";
import { Button, Card } from "../../../ui/primitives";
import { cn } from "../../../ui/primitives/styles";
import type { DocumentCardProps, DocumentType } from "../types";

const getDocumentIcon = (type?: DocumentType) => {
  switch (type) {
    case "prp":
      return <Rocket className="w-4 h-4" />;
    case "technical":
      return <Code className="w-4 h-4" />;
    case "business":
      return <Briefcase className="w-4 h-4" />;
    case "meeting_notes":
      return <Users className="w-4 h-4" />;
    case "spec":
      return <FileText className="w-4 h-4" />;
    case "design":
      return <Database className="w-4 h-4" />;
    case "api":
      return <FileCode className="w-4 h-4" />;
    case "guide":
      return <BookOpen className="w-4 h-4" />;
    default:
      return <Info className="w-4 h-4" />;
  }
};

const getTypeColor = (type?: DocumentType) => {
  switch (type) {
    case "prp":
      return { badge: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30", glow: "blue" };
    case "technical":
      return { badge: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30", glow: "green" };
    case "business":
      return { badge: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30", glow: "purple" };
    case "meeting_notes":
      return { badge: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30", glow: "orange" };
    case "spec":
      return { badge: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30", glow: "cyan" };
    case "design":
      return { badge: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30", glow: "pink" };
    case "api":
      return { badge: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30", glow: "green" };
    case "guide":
      return { badge: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30", glow: "orange" };
    default:
      return { badge: "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30", glow: "cyan" };
  }
};

export const DocumentCard = memo(({ document, isActive, onSelect, onDelete }: DocumentCardProps) => {
  const [showDelete, setShowDelete] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const typeColors = getTypeColor(document.document_type as DocumentType);

  const handleCopyId = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      const result = await copyToClipboard(document.id);
      if (result.success) {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      }
    },
    [document.id],
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(document);
    },
    [document, onDelete],
  );

  const handleCardClick = () => {
    onSelect(document);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(document);
    }
  };

  return (
    <Card
      blur="none"
      transparency="light"
      glowColor={isActive ? (typeColors.glow as any) : "none"}
      glowType="inner"
      glowSize="md"
      size="sm"
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={handleCardClick}
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
      aria-label={`${isActive ? "Selected: " : ""}${document.title}`}
      className={cn("relative w-full cursor-pointer transition-all duration-300 group", isActive && "scale-[1.02]")}
    >
        <div>
        {/* Document Type Badge */}
        <div
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium mb-2 border",
            typeColors.badge,
          )}
        >
          {getDocumentIcon(document.document_type as DocumentType)}
          <span>{document.document_type || "document"}</span>
        </div>

        {/* Title */}
        <h4 className="font-medium text-gray-900 dark:text-white text-sm line-clamp-2 mb-1">{document.title}</h4>

        {/* Metadata */}
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {new Date(document.updated_at || document.created_at || Date.now()).toLocaleDateString()}
        </p>

        {/* ID Display Section - Always visible for active, hover for others */}
        <div
          className={cn(
            "flex items-center justify-between mt-2 transition-opacity duration-200",
            isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[120px]" title={document.id}>
            {document.id.slice(0, 8)}...
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyId}
            className="p-1 h-auto min-h-0"
            title="Copy Document ID to clipboard"
            aria-label="Copy Document ID to clipboard"
          >
            {isCopied ? (
              <span className="text-green-500 text-xs">✓</span>
            ) : (
              <Clipboard className="w-3 h-3" aria-hidden="true" />
            )}
          </Button>
        </div>

        {/* Delete Button - show on hover OR when selected */}
        {(showDelete || isActive) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            className="absolute top-2 right-2 p-1 h-auto min-h-0 text-red-600 dark:text-red-400 hover:bg-red-500/20"
            aria-label={`Delete ${document.title}`}
            title="Delete document"
          >
            <Trash2 className="w-4 h-4" aria-hidden="true" />
          </Button>
        )}
        </div>
    </Card>
  );
});

DocumentCard.displayName = "DocumentCard";
