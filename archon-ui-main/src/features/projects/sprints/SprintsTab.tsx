import { Plus, Zap } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/primitives";
import { NewSprintModal } from "./components/NewSprintModal";
import { SprintCard } from "./components/SprintCard";
import { useCreateSprint, useDeleteSprint, useProjectSprints } from "./hooks";
import type { CreateSprintRequest } from "./types";

interface SprintsTabProps {
  projectId: string;
}

export function SprintsTab({ projectId }: SprintsTabProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const { data: sprints = [], isLoading } = useProjectSprints(projectId);
  const createSprintMutation = useCreateSprint();
  const deleteSprintMutation = useDeleteSprint(projectId);

  const handleCreate = (data: CreateSprintRequest) => {
    createSprintMutation.mutate(data);
  };

  const handleDelete = (sprintId: string) => {
    deleteSprintMutation.mutate(sprintId);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-orange-500 dark:text-orange-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Sprints</h3>
          <span className="text-sm text-gray-400 dark:text-gray-500">({sprints.length})</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center gap-1.5 text-orange-600 dark:text-orange-400 border-orange-400/40 hover:bg-orange-500/10"
        >
          <Plus className="w-4 h-4" />
          New Sprint
        </Button>
      </div>

      {/* Sprint List */}
      {sprints.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Zap className="w-12 h-12 text-gray-200 dark:text-gray-700 mb-4" />
          <p className="text-gray-500 dark:text-gray-400 text-sm">No sprints yet</p>
          <p className="text-gray-400 dark:text-gray-500 text-xs mt-1">Create a sprint to organize tasks by iteration</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsModalOpen(true)}
            className="mt-4 text-orange-600 dark:text-orange-400 border-orange-400/40 hover:bg-orange-500/10"
          >
            <Plus className="w-4 h-4 mr-1" />
            Create first sprint
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sprints.map((sprint) => (
            <SprintCard key={sprint.id} sprint={sprint} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {/* New Sprint Modal */}
      <NewSprintModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        projectId={projectId}
        onSubmit={handleCreate}
        isSubmitting={createSprintMutation.isPending}
      />
    </div>
  );
}
