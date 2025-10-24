import { Activity, AlertCircle, CheckCircle2, Clock, Plus } from "lucide-react";
import { useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../ui/primitives/button";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import type { AgentWorkOrderStatus } from "../types";
import { WorkOrderKanbanColumn } from "../components/WorkOrderKanbanColumn";
import { useRepositoryWorkOrders, useUpdateWorkOrderStatus, useDeleteWorkOrder } from "../hooks/useAgentWorkOrderQueries";
import { CreateWorkOrderDialog } from "../components/CreateWorkOrderDialog";

interface WorkOrderKanbanViewProps {
	repositoryId: string;
	repositoryName: string;
}

interface ColumnConfig {
	status: AgentWorkOrderStatus;
	title: string;
	icon: LucideIcon;
	color: string;
}

const columns: ColumnConfig[] = [
	{ status: "todo", title: "To Do", icon: Clock, color: "gray" },
	{ status: "in_progress", title: "In Progress", icon: Activity, color: "blue" },
	{ status: "review", title: "Review", icon: AlertCircle, color: "yellow" },
	{ status: "done", title: "Done", icon: CheckCircle2, color: "green" },
];

export const WorkOrderKanbanView = ({ repositoryId, repositoryName }: WorkOrderKanbanViewProps) => {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [hoveredWorkOrderId, setHoveredWorkOrderId] = useState<string | null>(null);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [workOrderToDelete, setWorkOrderToDelete] = useState<{ id: string; request: string } | null>(null);

	const { data: workOrders = [], isLoading, error } = useRepositoryWorkOrders(repositoryId);
	const updateStatusMutation = useUpdateWorkOrderStatus();
	const deleteWorkOrderMutation = useDeleteWorkOrder();

	// Filter work orders by status
	const getWorkOrdersByStatus = (status: AgentWorkOrderStatus) => {
		return workOrders
			.filter((wo) => wo.status === status)
			.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
	};

	// Handle work order status change from drag and drop
	const handleWorkOrderMove = (workOrderId: string, newStatus: AgentWorkOrderStatus) => {
		updateStatusMutation.mutate({ id: workOrderId, status: newStatus });
	};

	// Handle work order click to navigate to detail
	const handleWorkOrderClick = (workOrderId: string) => {
		window.location.href = `/agent-work-orders/detail/${workOrderId}`;
	};

	// Handle work order delete
	const handleWorkOrderDelete = (workOrderId: string) => {
		const workOrder = workOrders.find((wo) => wo.agent_work_order_id === workOrderId);
		if (!workOrder) return;
		setWorkOrderToDelete({ id: workOrderId, request: workOrder.user_request });
		setShowDeleteConfirm(true);
	};

	const confirmDelete = () => {
		if (!workOrderToDelete) return;
		deleteWorkOrderMutation.mutate(workOrderToDelete.id, {
			onSuccess: () => {
				setShowDeleteConfirm(false);
				setWorkOrderToDelete(null);
			},
		});
	};

	const cancelDelete = () => {
		setShowDeleteConfirm(false);
		setWorkOrderToDelete(null);
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-96">
				<p className="text-gray-600 dark:text-gray-400">Loading work orders...</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-96">
				<p className="text-red-600 dark:text-red-400">Failed to load work orders: {error.message}</p>
			</div>
		);
	}

	return (
		<>
			<DndProvider backend={HTML5Backend}>
				<div className="flex flex-col h-full">
					{/* Header with Create button */}
					<div className="flex items-center justify-between mb-4">
						<h2 className="text-xl font-bold text-gray-800 dark:text-white">Work Orders for {repositoryName}</h2>
						<Button onClick={() => setIsCreateDialogOpen(true)} variant="cyan" size="sm">
							<Plus className="w-4 h-4 mr-2" />
							New Work Order
						</Button>
					</div>

					{/* Kanban Board Grid */}
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 flex-1 p-2 min-h-[500px]">
						{columns.map((column) => (
							<WorkOrderKanbanColumn
								key={column.status}
								status={column.status}
								title={column.title}
								icon={column.icon}
								color={column.color}
								workOrders={getWorkOrdersByStatus(column.status)}
								onWorkOrderClick={handleWorkOrderClick}
								onWorkOrderMove={handleWorkOrderMove}
								onWorkOrderDelete={handleWorkOrderDelete}
								hoveredWorkOrderId={hoveredWorkOrderId}
								onWorkOrderHover={setHoveredWorkOrderId}
							/>
						))}
					</div>
				</div>
			</DndProvider>

			{/* Create Work Order Dialog */}
			<CreateWorkOrderDialog
				repositoryId={repositoryId}
				repositoryName={repositoryName}
				open={isCreateDialogOpen}
				onOpenChange={setIsCreateDialogOpen}
			/>

			{/* Delete Confirmation Modal */}
			<DeleteConfirmModal
				open={showDeleteConfirm}
				itemName={workOrderToDelete?.request || ""}
				type="task"
				onConfirm={confirmDelete}
				onCancel={cancelDelete}
				isDeleting={deleteWorkOrderMutation.isPending}
			/>
		</>
	);
};
