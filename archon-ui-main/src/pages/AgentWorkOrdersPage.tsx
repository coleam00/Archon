/**
 * AgentWorkOrdersPage Component
 *
 * Route wrapper for the agent work orders feature.
 * Delegates to AgentWorkOrdersView for actual implementation.
 */

import { AgentWorkOrdersView } from "@/features/agent-work-orders/views/AgentWorkOrdersView";

function AgentWorkOrdersPage() {
	return <AgentWorkOrdersView />;
}

export { AgentWorkOrdersPage };
