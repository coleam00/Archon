import { X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { useCreateSprint } from "../hooks/useSprintQueries";
import type { SprintStatus } from "../types";

interface CreateSprintModalProps {
  projectId: string;
  onClose: () => void;
  onCreated?: (sprintId: string) => void;
}

export function CreateSprintModal({ projectId, onClose, onCreated }: CreateSprintModalProps) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const createSprint = useCreateSprint();
  const uid = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      const sprint = await createSprint.mutateAsync({
        project_id: projectId,
        name: name.trim(),
        goal: goal.trim() || undefined,
        status: "planning" as SprintStatus,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
      });
      onCreated?.(sprint.id);
      onClose();
    } catch {
      // Error handled by useCreateSprint onError (toast shown) — do not propagate
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white">New Sprint</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className="block text-sm font-medium text-gray-300 mb-1.5">
              Sprint Name <span className="text-red-400">*</span>
            </label>
            <input
              id={`${uid}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sprint 1 — Core Features"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500/50 text-sm"
              required
            />
          </div>

          <div>
            <label htmlFor={`${uid}-goal`} className="block text-sm font-medium text-gray-300 mb-1.5">
              Sprint Goal
            </label>
            <textarea
              id={`${uid}-goal`}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What should be achieved by end of this sprint?"
              rows={2}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500/50 text-sm resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-start`} className="block text-sm font-medium text-gray-300 mb-1.5">
                Start Date
              </label>
              <input
                id={`${uid}-start`}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-cyan-500/50 text-sm"
              />
            </div>
            <div>
              <label htmlFor={`${uid}-end`} className="block text-sm font-medium text-gray-300 mb-1.5">
                End Date
              </label>
              <input
                id={`${uid}-end`}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate || undefined}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-cyan-500/50 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim() || createSprint.isPending}>
              {createSprint.isPending ? "Creating..." : "Create Sprint"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
