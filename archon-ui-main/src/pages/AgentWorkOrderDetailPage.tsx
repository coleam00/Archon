/**
 * AgentWorkOrderDetailPage Component
 *
 * Route wrapper for the agent work order detail view with breadcrumb navigation.
 * Delegates to WorkOrderDetailView for actual implementation.
 */

import { useParams, Link } from "react-router-dom";
import { WorkOrderDetailView } from "@/features/agent-work-orders/views/WorkOrderDetailView";
import { useWorkOrder } from "@/features/agent-work-orders/hooks/useAgentWorkOrderQueries";
import { useRepository } from "@/features/agent-work-orders/hooks/useRepositoryQueries";

function AgentWorkOrderDetailPage() {
	const { workOrderId } = useParams<{ workOrderId: string }>();
	const { data: workOrder } = useWorkOrder(workOrderId);
	const { data: repository } = useRepository(workOrder?.repository_id);

	return (
		<div className="max-w-full mx-auto px-6 md:px-8 py-6">
			{/* Breadcrumb Navigation */}
			<nav className="mb-6" aria-label="Breadcrumb">
				<ol className="flex items-center gap-2 text-sm">
					<li>
						<Link
							to="/agent-work-orders"
							className="text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
						>
							Repositories
						</Link>
					</li>
					<li className="text-gray-400 dark:text-gray-600">/</li>
					{repository && (
						<>
							<li>
								<Link
									to={`/agent-work-orders/${repository.id}`}
									className="text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
								>
									{repository.repository_display_name || repository.repository_name}
								</Link>
							</li>
							<li className="text-gray-400 dark:text-gray-600">/</li>
						</>
					)}
					<li className="text-gray-900 dark:text-white font-medium">Work Order {workOrder?.agent_work_order_id}</li>
				</ol>
			</nav>

			{/* Actual Detail View */}
			<WorkOrderDetailView />
		</div>
	);
}

export { AgentWorkOrderDetailPage };
