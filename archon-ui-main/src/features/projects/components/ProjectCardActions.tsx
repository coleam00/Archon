import { Clipboard, Pin, Trash2 } from "lucide-react";
import type React from "react";
import { useToast } from "../../ui/hooks/useToast";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";

interface ProjectCardActionsProps {
  projectId: string;
  projectTitle: string;
  isPinned: boolean;
  onPin: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  isDeleting?: boolean;
}

export const ProjectCardActions: React.FC<ProjectCardActionsProps> = ({
  projectId,
  projectTitle,
  isPinned,
  onPin,
  onDelete,
  isDeleting = false,
}) => {
  const { showToast } = useToast();

  const handleCopyId = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(projectId);
      showToast("Project ID copied to clipboard", "success");
    } catch {
      // Fallback for older browsers
      try {
        const ta = document.createElement("textarea");
        ta.value = projectId;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast("Project ID copied to clipboard", "success");
      } catch {
        showToast("Failed to copy Project ID", "error");
      }
    }
  };
  return (
    <div className="flex items-center gap-1.5">
      {/* Delete Button */}
      <SimpleTooltip content={isDeleting ? "Deleting..." : "Delete project"}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!isDeleting) onDelete(e);
          }}
          disabled={isDeleting}
          className={cn(
            "w-5 h-5 rounded-full flex items-center justify-center",
            "transition-all duration-300",
            glassmorphism.priority.critical.background,
            glassmorphism.priority.critical.text,
            glassmorphism.priority.critical.hover,
            glassmorphism.priority.critical.glow,
            isDeleting && "opacity-50 cursor-not-allowed",
          )}
          aria-label={isDeleting ? "Deleting project..." : `Delete ${projectTitle}`}
        >
          <Trash2 className={cn("w-3 h-3", isDeleting && "animate-pulse")} />
        </button>
      </SimpleTooltip>

      {/* Pin Button */}
      <SimpleTooltip content={isPinned ? "Unpin project" : "Pin as default"}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPin(e);
          }}
          className={cn(
            "w-5 h-5 rounded-full flex items-center justify-center",
            "transition-all duration-300",
            isPinned
              ? "bg-purple-100/80 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-500/30 hover:shadow-[0_0_10px_rgba(168,85,247,0.3)]"
              : glassmorphism.priority.medium.background +
                  " " +
                  glassmorphism.priority.medium.text +
                  " " +
                  glassmorphism.priority.medium.hover +
                  " " +
                  glassmorphism.priority.medium.glow,
          )}
          aria-label={isPinned ? "Unpin project" : "Pin as default"}
        >
          <Pin className={cn("w-3 h-3", isPinned && "fill-current")} />
        </button>
      </SimpleTooltip>

      {/* Copy Project ID Button */}
      <SimpleTooltip content="Copy Project ID">
        <button
          type="button"
          onClick={handleCopyId}
          className={cn(
            "w-5 h-5 rounded-full flex items-center justify-center",
            "transition-all duration-300",
            glassmorphism.priority.low.background,
            glassmorphism.priority.low.text,
            glassmorphism.priority.low.hover,
            glassmorphism.priority.low.glow,
          )}
          aria-label="Copy Project ID"
        >
          <Clipboard className="w-3 h-3" />
        </button>
      </SimpleTooltip>
    </div>
  );
};
