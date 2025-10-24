import { formatDistanceToNow } from "date-fns";
import { useDrag } from "react-dnd";
import { isOptimistic } from "@/features/shared/utils/optimistic";
import { Card } from "../../ui/primitives";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { cn } from "../../ui/primitives/styles";
import type { AgentWorkOrder } from "../types";
import { ItemTypes } from "../utils/work-order-styles";
import { WorkOrderCardActions } from "./WorkOrderCardActions";

interface WorkOrderKanbanCardProps {
	workOrder: AgentWorkOrder;
	onClick: () => void;
	onDelete: (workOrderId: string) => void;
	hoveredWorkOrderId: string | null;
	onWorkOrderHover: (id: string | null) => void;
}

export const WorkOrderKanbanCard = ({
	workOrder,
	onClick,
	onDelete,
	hoveredWorkOrderId,
	onWorkOrderHover,
}: WorkOrderKanbanCardProps) => {
	const optimistic = isOptimistic(workOrder);

	const [{ isDragging }, drag] = useDrag({
		type: ItemTypes.WORK_ORDER,
		item: { id: workOrder.agent_work_order_id, status: workOrder.status },
		collect: (monitor) => ({
			isDragging: !!monitor.isDragging(),
		}),
	});

	const isHighlighted = hoveredWorkOrderId === workOrder.agent_work_order_id;

	const handleMouseEnter = () => {
		onWorkOrderHover(workOrder.agent_work_order_id);
	};

	const handleMouseLeave = () => {
		onWorkOrderHover(null);
	};

	const handleDelete = () => {
		onDelete(workOrder.agent_work_order_id);
	};

	// Get status color for left border
	const getStatusColor = () => {
		switch (workOrder.status) {
			case "todo":
				return "bg-gray-500";
			case "in_progress":
				return "bg-blue-500";
			case "review":
				return "bg-orange-500";
			case "done":
				return "bg-green-500";
			default:
				return "bg-gray-500";
		}
	};

	const getStatusGlow = () => {
		switch (workOrder.status) {
			case "todo":
				return "shadow-[0_0_8px_rgba(156,163,175,0.6)]";
			case "in_progress":
				return "shadow-[0_0_8px_rgba(59,130,246,0.6)]";
			case "review":
				return "shadow-[0_0_8px_rgba(249,115,22,0.6)]";
			case "done":
				return "shadow-[0_0_8px_rgba(34,197,94,0.6)]";
			default:
				return "shadow-[0_0_8px_rgba(156,163,175,0.6)]";
		}
	};

	return (
		<div
			ref={drag}
			role="button"
			tabIndex={0}
			className={cn(
				"w-full min-h-[140px] cursor-move relative group",
				"transition-all duration-200 ease-in-out",
				isDragging ? "opacity-50 scale-90" : "scale-100 opacity-100",
			)}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					onClick();
				}
			}}
		>
			<Card
				blur="md"
				transparency="light"
				size="none"
				className={cn(
					"transition-all duration-200 ease-in-out",
					"w-full min-h-[140px] h-full",
					isHighlighted && "border-cyan-400/50 shadow-[0_0_8px_rgba(34,211,238,0.2)]",
					"group-hover:border-cyan-400/70 dark:group-hover:border-cyan-500/50 group-hover:shadow-[0_0_15px_rgba(34,211,238,0.4)] dark:group-hover:shadow-[0_0_15px_rgba(34,211,238,0.6)]",
					optimistic && "opacity-80 ring-1 ring-cyan-400/30",
				)}
			>
				{/* Status indicator bar on left */}
				<div
					className={cn(
						"absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg opacity-80 group-hover:w-[4px] group-hover:opacity-100 transition-all duration-300",
						getStatusColor(),
						getStatusGlow(),
					)}
				/>

				{/* Content container */}
				<div className="flex flex-col h-full p-3">
					{/* Header with status badge and actions */}
					<div className="flex items-center gap-2 mb-2 pl-1.5">
						{/* Phase indicator (when in_progress) */}
						{workOrder.status === "in_progress" && workOrder.current_phase && (
							<div className="px-2 py-1 rounded-md text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
								{workOrder.current_phase}
							</div>
						)}

						{/* Optimistic indicator */}
						<OptimisticIndicator isOptimistic={optimistic} className="ml-auto" />

						{/* Action buttons */}
						<div className={cn("flex items-center gap-1.5", !optimistic && "ml-auto")}>
							<WorkOrderCardActions workOrderId={workOrder.agent_work_order_id} onDelete={handleDelete} />
						</div>
					</div>

					{/* User Request (title) */}
					<h4
						className="text-xs font-medium text-gray-900 dark:text-white mb-2 pl-1.5 line-clamp-2 overflow-hidden"
						title={workOrder.user_request}
					>
						{workOrder.user_request}
					</h4>

					{/* Work Order ID */}
					<div className="pl-1.5 mb-2">
						<p className="text-[11px] text-gray-500 dark:text-gray-400 font-mono">ID: {workOrder.agent_work_order_id}</p>
					</div>

					{/* Error message if present */}
					{workOrder.error_message && (
						<div className="pl-1.5 pr-3 mb-2">
							<p className="text-[11px] text-red-600 dark:text-red-400 line-clamp-2">{workOrder.error_message}</p>
						</div>
					)}

					{/* Spacer */}
					<div className="flex-1"></div>

					{/* Footer with created time */}
					<div className="flex items-center justify-between mt-auto pt-2 pl-1.5 pr-3 border-t border-gray-200/30 dark:border-gray-700/30">
						<p className="text-[11px] text-gray-500 dark:text-gray-400">
							{formatDistanceToNow(new Date(workOrder.created_at), { addSuffix: true })}
						</p>
						{workOrder.github_pull_request_url && (
							<span className="text-[11px] text-green-600 dark:text-green-400">PR Created</span>
						)}
					</div>
				</div>
			</Card>
		</div>
	);
};
