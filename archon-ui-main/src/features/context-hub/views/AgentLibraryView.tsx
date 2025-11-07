/**
 * Agent Library View
 *
 * Displays grid of agent template cards with search/filter.
 */

import { Search, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { AgentTemplateCard } from "../components/AgentTemplateCard";
import { CreateAgentModal } from "../components/CreateAgentModal";
import { EditAgentModal } from "../components/EditAgentModal";
import { useAgentTemplates } from "../hooks";
import { useContextHubStore } from "../state/contextHubStore";

export function AgentLibraryView() {
  const [searchQuery, setSearchQuery] = useState("");
  const isCreateModalOpen = useContextHubStore((s) => s.isCreateAgentModalOpen);
  const openCreateModal = useContextHubStore((s) => s.openCreateAgentModal);
  const closeCreateModal = useContextHubStore((s) => s.closeCreateAgentModal);
  const isEditModalOpen = useContextHubStore((s) => s.isEditAgentModalOpen);
  const editingSlug = useContextHubStore((s) => s.editingAgentSlug);
  const closeEditModal = useContextHubStore((s) => s.closeEditAgentModal);

  const { data: templates, isLoading, error } = useAgentTemplates();

  const filteredTemplates =
    templates?.filter((t) =>
      searchQuery && searchQuery.trim()
        ? t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          t.description?.toLowerCase().includes(searchQuery.toLowerCase())
        : true,
    ) || [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-600 dark:text-gray-400">Loading agent templates...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-red-600 dark:text-red-400">Error loading templates: {String(error)}</p>
      </div>
    );
  }

  if (filteredTemplates.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <p className="text-gray-600 dark:text-gray-400 mb-4">No agent templates found</p>
          <Button variant="cyan" onClick={openCreateModal}>
            Create Agent Template
          </Button>
          <CreateAgentModal open={isCreateModalOpen} onOpenChange={closeCreateModal} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          Agent Templates ({filteredTemplates.length})
        </h2>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-initial sm:w-64">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
          </div>
          <Button variant="cyan" onClick={openCreateModal} size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            Create
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filteredTemplates.map((template) => (
          <AgentTemplateCard key={template.id} template={template} />
        ))}
      </div>

      <CreateAgentModal open={isCreateModalOpen} onOpenChange={closeCreateModal} />
      <EditAgentModal open={isEditModalOpen} onOpenChange={closeEditModal} slug={editingSlug} />
    </div>
  );
}
