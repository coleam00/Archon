/**
 * AgentWorkOrderDetailPage Component
 *
 * Route wrapper for the agent work order detail view.
 * Delegates to WorkOrderDetailView for actual implementation.
 */

import { WorkOrderDetailView } from "@/features/agent-work-orders/views/WorkOrderDetailView";

function AgentWorkOrderDetailPage() {
	return <WorkOrderDetailView />;
}

export { AgentWorkOrderDetailPage };
