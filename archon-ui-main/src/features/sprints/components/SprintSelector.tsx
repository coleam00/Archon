import { Plus } from "lucide-react";
import { useState } from "react";
import type { Project } from "@/features/projects/types";
import { Button } from "@/features/ui/primitives/button";
import { useProjectSprints } from "../hooks/useSprintQueries";
import type { Sprint, SprintStatus } from "../types";
import { CreateSprintModal } from "./CreateSprintModal";

const STATUS_COLORS: Record<SprintStatus, string> = {
  planning: "text-gray-400 bg-gray-500/20 border-gray-500/30",
  ready_for_kickoff: "text-yellow-400 bg-yellow-500/20 border-yellow-500/30",
  active: "text-cyan-400 bg-cyan-500/20 border-cyan-500/30",
  review: "text-purple-400 bg-purple-500/20 border-purple-500/30",
  completed: "text-green-400 bg-green-500/20 border-green-500/30",
  cancelled: "text-red-400 bg-red-500/20 border-red-500/30",
};

interface SprintSelectorProps {
  projects: Project[];
  selectedProjectId: string | null;
  selectedSprintId: string | null;
  onProjectChange: (projectId: string) => void;
  onSprintChange: (sprintId: string) => void;
  onSprintCreated?: (sprintId: string) => void;
}

export function SprintSelector({
  projects,
  selectedProjectId,
  selectedSprintId,
  onProjectChange,
  onSprintChange,
  onSprintCreated,
}: SprintSelectorProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);

  const { data: sprints = [], isLoading: sprintsLoading, isError: sprintsError } = useProjectSprints(selectedProjectId ?? undefined);

  const selectedSprint = sprints.find((s: Sprint) => s.id === selectedSprintId);

  const handleSprintCreated = (sprintId: string) => {
    onSprintChange(sprintId);
    onSprintCreated?.(sprintId);
  };

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        {/* Project selector */}
        <select
          value={selectedProjectId ?? ""}
          onChange={(e) => onProjectChange(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500/50"
        >
          <option value="" disabled>
            Select project…
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>

        {/* Sprint selector */}
        {selectedProjectId && (
          <select
            value={sprintsLoading || sprintsError ? "" : (selectedSprintId ?? "")}
            onChange={(e) => onSprintChange(e.target.value)}
            disabled={sprintsLoading}
            className="bg-zinc-800 border border-zinc-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-cyan-500/50 disabled:opacity-50"
          >
            <option value="" disabled>
              {sprintsLoading ? "Loading sprints…" : sprintsError ? "Failed to load sprints" : "Select sprint…"}
            </option>
            {!sprintsLoading && !sprintsError && sprints.map((s: Sprint) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}

        {/* Status badge */}
        {selectedSprint && (
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${STATUS_COLORS[selectedSprint.status]}`}
          >
            {selectedSprint.status}
          </span>
        )}

        {/* New sprint button */}
        {selectedProjectId && (
          <Button size="sm" variant="ghost" onClick={() => setShowCreateModal(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New Sprint
          </Button>
        )}
      </div>

      {showCreateModal && selectedProjectId && (
        <CreateSprintModal
          projectId={selectedProjectId}
          onClose={() => setShowCreateModal(false)}
          onCreated={handleSprintCreated}
        />
      )}
    </>
  );
}
