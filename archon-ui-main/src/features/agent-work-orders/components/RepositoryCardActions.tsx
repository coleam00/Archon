import { Clipboard, Pin, Trash2 } from "lucide-react";
import type React from "react";
import { useToast } from "@/features/shared/hooks/useToast";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";

interface RepositoryCardActionsProps {
	repositoryId: string;
	repositoryName: string;
	isPinned: boolean;
	onPin: (e: React.MouseEvent) => void;
	onDelete: (e: React.MouseEvent) => void;
	isDeleting?: boolean;
}

export const RepositoryCardActions: React.FC<RepositoryCardActionsProps> = ({
	repositoryId,
	repositoryName,
	isPinned,
	onPin,
	onDelete,
	isDeleting = false,
}) => {
	const { showToast } = useToast();

	const handleCopyId = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(repositoryId);
			showToast("Repository ID copied to clipboard", "success");
		} catch {
			// Fallback for older browsers
			try {
				const ta = document.createElement("textarea");
				ta.value = repositoryId;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				showToast("Repository ID copied to clipboard", "success");
			} catch {
				showToast("Failed to copy Repository ID", "error");
			}
		}
	};

	return (
		<div className="flex items-center gap-1.5">
			{/* Delete Button */}
			<SimpleTooltip content={isDeleting ? "Deleting..." : "Delete repository"}>
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
					aria-label={isDeleting ? "Deleting repository..." : `Delete ${repositoryName}`}
				>
					<Trash2 className={cn("w-3 h-3", isDeleting && "animate-pulse")} />
				</button>
			</SimpleTooltip>

			{/* Pin Button */}
			<SimpleTooltip content={isPinned ? "Unpin repository" : "Pin as default"}>
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
							? "bg-blue-100/80 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-500/30 hover:shadow-[0_0_10px_rgba(59,130,246,0.3)]"
							: glassmorphism.priority.medium.background +
									" " +
									glassmorphism.priority.medium.text +
									" " +
									glassmorphism.priority.medium.hover +
									" " +
									glassmorphism.priority.medium.glow,
					)}
					aria-label={isPinned ? "Unpin repository" : "Pin as default"}
				>
					<Pin className={cn("w-3 h-3", isPinned && "fill-current")} />
				</button>
			</SimpleTooltip>

			{/* Copy Repository ID Button */}
			<SimpleTooltip content="Copy Repository ID">
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
					aria-label="Copy Repository ID"
				>
					<Clipboard className="w-3 h-3" />
				</button>
			</SimpleTooltip>
		</div>
	);
};
