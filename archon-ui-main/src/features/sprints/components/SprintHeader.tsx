import { Calendar, ChevronDown, Clock, Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "@/features/projects/tasks/types";
import { useUpdateSprint } from "../hooks/useSprintQueries";
import type { Sprint, SprintStatus } from "../types";

const STATUS_CONFIG: Record<SprintStatus, { label: string; className: string }> = {
  planning: { label: "Planning", className: "text-gray-400 bg-gray-500/20 border-gray-500/30" },
  ready_for_kickoff: { label: "Ready for Kickoff", className: "text-yellow-400 bg-yellow-500/20 border-yellow-500/30" },
  active: { label: "Active", className: "text-cyan-400 bg-cyan-500/20 border-cyan-500/30" },
  review: { label: "In Review", className: "text-purple-400 bg-purple-500/20 border-purple-500/30" },
  completed: { label: "Completed", className: "text-green-400 bg-green-500/20 border-green-500/30" },
  cancelled: { label: "Cancelled", className: "text-red-400 bg-red-500/20 border-red-500/30" },
};

// Transitions any agent can make (no gate)
const AGENT_TRANSITIONS: Record<SprintStatus, SprintStatus[]> = {
  planning: ["ready_for_kickoff", "cancelled"],
  ready_for_kickoff: ["planning", "cancelled"],
  active: ["review", "completed", "cancelled"],
  review: ["completed", "active"],
  completed: [],
  cancelled: [],
};

interface SprintHeaderProps {
  sprint: Sprint;
  tasks: Task[];
  isProductOwner?: boolean; // true when acting as "user" role
}

export function SprintHeader({ sprint, tasks, isProductOwner = true }: SprintHeaderProps) {
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const updateSprint = useUpdateSprint(sprint.project_id);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const doneTasks = tasks.filter((t) => t.status === "done").length;
  const totalTasks = tasks.length;
  const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const currentStatus = STATUS_CONFIG[sprint.status];
  const agentTransitions = AGENT_TRANSITIONS[sprint.status];

  const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return null;
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const handleStatusChange = (newStatus: SprintStatus, requestedBy?: string) => {
    setShowStatusMenu(false);
    updateSprint.mutate({
      sprintId: sprint.id,
      data: { status: newStatus, ...(requestedBy ? { requested_by: requestedBy } : {}) },
    });
  };

  const isAwaitingPOApproval = sprint.status === "ready_for_kickoff";

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl px-6 py-5 space-y-4">
      {/* PO approval gate banner */}
      {isAwaitingPOApproval && !isProductOwner && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
          <Clock className="h-4 w-4 text-yellow-400 shrink-0" />
          <span className="text-sm text-yellow-300 font-medium">AWAITING PO APPROVAL — Sprint is ready for kickoff</span>
        </div>
      )}

      {/* Top row */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-bold text-white truncate">{sprint.name}</h2>
          {sprint.goal && (
            <div className="flex items-center gap-1.5 mt-1">
              <Target className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
              <p className="text-sm text-gray-400 line-clamp-2">{sprint.goal}</p>
            </div>
          )}
        </div>

        {/* Status controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* PO "Approve & Start Sprint" button */}
          {isAwaitingPOApproval && isProductOwner && (
            <button
              type="button"
              onClick={() => handleStatusChange("active", "user")}
              disabled={updateSprint.isPending}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-400 text-black transition-colors disabled:opacity-50"
            >
              Approve & Start Sprint
            </button>
          )}

          {/* Status badge with dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => agentTransitions.length > 0 && setShowStatusMenu(!showStatusMenu)}
              disabled={updateSprint.isPending}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 ${currentStatus.className} ${agentTransitions.length > 0 ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
            >
              {currentStatus.label}
              {agentTransitions.length > 0 && <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {showStatusMenu && agentTransitions.length > 0 && (
              <div className="absolute right-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-10 min-w-[160px]">
                {agentTransitions.map((status) => (
                  <button
                    type="button"
                    key={status}
                    onClick={() => handleStatusChange(status)}
                    className={`w-full text-left px-3 py-2 text-sm first:rounded-t-lg last:rounded-b-lg hover:bg-zinc-700 transition-colors ${STATUS_CONFIG[status].className.split(" ")[0]}`}
                  >
                    {status === "ready_for_kickoff" ? "Mark Ready for Kickoff" : `Mark as ${STATUS_CONFIG[status].label}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Date range */}
      {(sprint.start_date || sprint.end_date) && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Calendar className="h-4 w-4 text-gray-500" />
          <span>
            {formatDate(sprint.start_date) ?? "—"} → {formatDate(sprint.end_date) ?? "—"}
          </span>
        </div>
      )}

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-gray-400">
          <span>
            {doneTasks} / {totalTasks} tasks done
          </span>
          <span className="font-medium text-white">{progressPct}%</span>
        </div>
        <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
