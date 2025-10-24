import { useRef } from "react";
import { useDrop } from "react-dnd";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../ui/primitives/styles";
import type { AgentWorkOrder, AgentWorkOrderStatus } from "../types";
import { ItemTypes, getColumnGlow } from "../utils/work-order-styles";
import { WorkOrderKanbanCard } from "./WorkOrderKanbanCard";

interface WorkOrderKanbanColumnProps {
	status: AgentWorkOrderStatus;
	title: string;
	icon: LucideIcon;
	color: string;
	workOrders: AgentWorkOrder[];
	onWorkOrderClick: (id: string) => void;
	onWorkOrderMove: (id: string, newStatus: AgentWorkOrderStatus) => void;
	onWorkOrderDelete: (id: string) => void;
	hoveredWorkOrderId: string | null;
	onWorkOrderHover: (id: string | null) => void;
}

export const WorkOrderKanbanColumn = ({
	status,
	title,
	icon: Icon,
	color,
	workOrders,
	onWorkOrderClick,
	onWorkOrderMove,
	onWorkOrderDelete,
	hoveredWorkOrderId,
	onWorkOrderHover,
}: WorkOrderKanbanColumnProps) => {
	const ref = useRef<HTMLDivElement>(null);

	const [, drop] = useDrop({
		accept: ItemTypes.WORK_ORDER,
		drop: (item: { id: string; status: AgentWorkOrderStatus }) => {
			if (item.status !== status) {
				onWorkOrderMove(item.id, status);
			}
		},
	});

	drop(ref);

	// Get color classes based on status
	const getStatusColorClasses = () => {
		switch (color) {
			case "gray":
				return "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30";
			case "blue":
				return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30";
			case "yellow":
				return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30";
			case "green":
				return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30";
			default:
				return "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30";
		}
	};

	return (
		<div ref={ref} className="flex flex-col h-full">
			{/* Column Header */}
			<div className="text-center py-3 relative">
				<div className="flex items-center justify-center">
					<div
						className={cn(
							"inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium border backdrop-blur-md",
							getStatusColorClasses(),
						)}
					>
						<Icon className="w-3 h-3" />
						<span className="font-medium">{title}</span>
						<span className="font-bold">{workOrders.length}</span>
					</div>
				</div>
				{/* Colored underline glow */}
				<div
					className={cn(
						"absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[1px]",
						getColumnGlow(status),
						"shadow-md",
					)}
				/>
			</div>

			{/* Work Orders Container */}
			<div className="px-2 flex-1 overflow-y-auto space-y-2 py-3 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-700">
				{workOrders.map((workOrder) => (
					<WorkOrderKanbanCard
						key={workOrder.agent_work_order_id}
						workOrder={workOrder}
						onClick={() => onWorkOrderClick(workOrder.agent_work_order_id)}
						onDelete={onWorkOrderDelete}
						hoveredWorkOrderId={hoveredWorkOrderId}
						onWorkOrderHover={onWorkOrderHover}
					/>
				))}
			</div>
		</div>
	);
};
