import { Clipboard, Trash2 } from "lucide-react";
import type React from "react";
import { useToast } from "@/features/shared/hooks/useToast";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import { SimpleTooltip } from "../../ui/primitives/tooltip";

interface WorkOrderCardActionsProps {
	workOrderId: string;
	onDelete: () => void;
	isDeleting?: boolean;
}

export const WorkOrderCardActions: React.FC<WorkOrderCardActionsProps> = ({
	workOrderId,
	onDelete,
	isDeleting = false,
}) => {
	const { showToast } = useToast();

	const handleCopyId = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(workOrderId);
			showToast("Work Order ID copied to clipboard", "success");
		} catch {
			try {
				const ta = document.createElement("textarea");
				ta.value = workOrderId;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				showToast("Work Order ID copied to clipboard", "success");
			} catch {
				showToast("Failed to copy Work Order ID", "error");
			}
		}
	};

	return (
		<div className="flex items-center gap-1.5">
			<SimpleTooltip content={isDeleting ? "Deleting..." : "Delete work order"}>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						if (!isDeleting) onDelete();
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
					aria-label={isDeleting ? "Deleting work order..." : `Delete work order ${workOrderId}`}
				>
					<Trash2 className={cn("w-3 h-3", isDeleting && "animate-pulse")} />
				</button>
			</SimpleTooltip>

			<SimpleTooltip content="Copy Work Order ID">
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
					aria-label="Copy Work Order ID"
				>
					<Clipboard className="w-3 h-3" />
				</button>
			</SimpleTooltip>
		</div>
	);
};
