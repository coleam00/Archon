/**
 * AgentWorkOrdersView Component
 *
 * Main view for displaying and managing agent work orders.
 * Combines the work order list with create dialog.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/features/ui/primitives/button";
import { CreateWorkOrderDialog } from "../components/CreateWorkOrderDialog";
import { WorkOrderList } from "../components/WorkOrderList";

export function AgentWorkOrdersView() {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const navigate = useNavigate();

  const handleWorkOrderClick = (workOrderId: string) => {
    navigate(`/agent-work-orders/${workOrderId}`);
  };

  const handleCreateSuccess = (workOrderId: string) => {
    navigate(`/agent-work-orders/${workOrderId}`);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Agent Work Orders</h1>
          <p className="text-gray-400">Create and monitor AI-driven development workflows</p>
        </div>
        <Button onClick={() => setIsCreateDialogOpen(true)}>Create Work Order</Button>
      </div>

      <WorkOrderList onWorkOrderClick={handleWorkOrderClick} />

      <CreateWorkOrderDialog
        open={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
}
