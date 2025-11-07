/**
 * Step Library View
 *
 * Displays grid of step template cards with type filter.
 */

import { Search, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { StepTemplateCard } from "../components/StepTemplateCard";
import { CreateStepModal } from "../components/CreateStepModal";
import { EditStepModal } from "../components/EditStepModal";
import { useStepTemplates } from "../hooks";
import { useContextHubStore } from "../state/contextHubStore";

export function StepLibraryView() {
  const [searchQuery, setSearchQuery] = useState("");
  const selectedStepType = useContextHubStore((s) => s.selectedStepType);
  const isCreateModalOpen = useContextHubStore((s) => s.isCreateStepModalOpen);
  const openCreateModal = useContextHubStore((s) => s.openCreateStepModal);
  const closeCreateModal = useContextHubStore((s) => s.closeCreateStepModal);
  const isEditModalOpen = useContextHubStore((s) => s.isEditStepModalOpen);
  const editingSlug = useContextHubStore((s) => s.editingStepSlug);
  const closeEditModal = useContextHubStore((s) => s.closeEditStepModal);

  const { data: templates, isLoading, error } = useStepTemplates(selectedStepType || undefined);

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
        <p className="text-gray-600 dark:text-gray-400">Loading step templates...</p>
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
          <p className="text-gray-600 dark:text-gray-400 mb-4">No step templates found</p>
          <Button variant="green" onClick={openCreateModal}>
            Create Step Template
          </Button>
          <CreateStepModal open={isCreateModalOpen} onOpenChange={closeCreateModal} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          Step Templates ({filteredTemplates.length})
        </h2>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-initial sm:w-64">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search steps..."
              className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <Button variant="green" onClick={openCreateModal} size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            Create
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filteredTemplates.map((template) => (
          <StepTemplateCard key={template.id} template={template} />
        ))}
      </div>

      <CreateStepModal open={isCreateModalOpen} onOpenChange={closeCreateModal} />
      <EditStepModal open={isEditModalOpen} onOpenChange={closeEditModal} slug={editingSlug} />
    </div>
  );
}
