import { Clock, Shield, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { useState } from "react";
import { useUpdateTask } from "@/features/projects/tasks/hooks/useTaskQueries";
import type { Task } from "@/features/projects/tasks/types";
import { Dialog, DialogContent } from "@/features/ui/primitives/dialog";

const PRIORITY_CONFIG = {
  critical: { label: "Critical", className: "bg-red-500/20 text-red-400 border-red-500/30" },
  high: { label: "High", className: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  medium: { label: "Medium", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  low: { label: "Low", className: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
};

// Engine → display config (mirrors AgentWarCard fallback)
const AGENT_DISPLAY: Record<string, { emoji: string; label: string; color: string }> = {
  claude: { emoji: "🔥", label: "Software Developer", color: "text-orange-400" },
  "claude-opus": { emoji: "🏗️", label: "Tech Lead", color: "text-cyan-400" },
  "claude-sonnet": { emoji: "🔍", label: "Reviewer", color: "text-blue-400" },
  "claude-haiku": { emoji: "⚡", label: "Planner", color: "text-green-400" },
  user: { emoji: "👑", label: "Product Owner", color: "text-slate-200" },
};

function getAgentDisplay(assignee: string | undefined) {
  if (!assignee) return { emoji: "🤖", label: assignee ?? "Unknown", color: "text-zinc-400" };
  const lower = assignee.toLowerCase();
  for (const [key, cfg] of Object.entries(AGENT_DISPLAY)) {
    if (lower.includes(key)) return { ...cfg, label: `${cfg.label} · ${assignee}` };
  }
  return { emoji: "🤖", label: assignee, color: "text-zinc-400" };
}

function formatTimeInReview(updatedAt: string): string {
  const diff = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

interface TaskReviewModalProps {
  task: Task;
  projectId: string;
  onClose: () => void;
}

export function TaskReviewModal({ task, projectId, onClose }: TaskReviewModalProps) {
  const [rejectReason, setRejectReason] = useState("");
  const updateTask = useUpdateTask(projectId);
  const agentDisplay = getAgentDisplay(task.assignee);
  const priorityCfg = PRIORITY_CONFIG[task.priority ?? "medium"] ?? PRIORITY_CONFIG.medium;

  function handleApprove() {
    updateTask.mutate(
      { taskId: task.id, updates: { status: "done", requested_by: "user" } },
      { onSuccess: onClose },
    );
  }

  function handleReject() {
    const updatedDescription = rejectReason.trim()
      ? `[REJECTED: ${rejectReason.trim()}]\n\n${task.description ?? ""}`.trimEnd()
      : task.description;

    updateTask.mutate(
      { taskId: task.id, updates: { status: "todo", description: updatedDescription } },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-blue-400">PO Review Gate</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Task title */}
        <h2 className="text-lg font-bold text-white leading-snug mb-3">{task.title}</h2>

        {/* Meta row */}
        <div className="flex items-center flex-wrap gap-2 mb-4">
          {task.feature && (
            <span className="text-xs text-gray-400 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5">
              {task.feature}
            </span>
          )}
          <span
            className={`text-xs font-medium border rounded px-2 py-0.5 ${priorityCfg.className}`}
          >
            {priorityCfg.label}
          </span>
        </div>

        {/* Submitted by + time in review */}
        <div className="flex items-center justify-between mb-4 px-3 py-2.5 bg-zinc-800/60 border border-zinc-700/50 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-base">{agentDisplay.emoji}</span>
            <div>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">Submitted by</p>
              <p className={`text-xs font-semibold ${agentDisplay.color}`}>{agentDisplay.label}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-gray-400">
            <Clock className="h-3.5 w-3.5" />
            <div className="text-right">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">In review</p>
              <p className="text-xs font-semibold text-white">{formatTimeInReview(task.updated_at)}</p>
            </div>
          </div>
        </div>

        {/* Description / completion notes */}
        <div className="mb-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">
            Description & completion notes
          </p>
          <div className="bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-3 max-h-48 overflow-y-auto">
            {task.description ? (
              <p className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed">{task.description}</p>
            ) : (
              <p className="text-sm text-gray-600 italic">No description provided.</p>
            )}
          </div>
        </div>

        {/* Reject reason */}
        <div className="mb-5">
          <label
            htmlFor="reject-reason"
            className="text-[10px] font-bold uppercase tracking-wider text-gray-500 block mb-2"
          >
            Reject reason <span className="text-gray-600 normal-case tracking-normal font-normal">(optional — required to send back)</span>
          </label>
          <textarea
            id="reject-reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="What needs to be fixed before this can be approved?"
            rows={2}
            className="w-full bg-zinc-900/60 border border-zinc-700/50 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-zinc-600 transition-colors"
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleReject}
            disabled={updateTask.isPending}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-40 transition-colors"
          >
            <ThumbsDown className="h-4 w-4" />
            Reject — Send Back
          </button>
          <button
            type="button"
            onClick={handleApprove}
            disabled={updateTask.isPending}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-bold bg-green-500/15 text-green-400 border border-green-500/30 hover:bg-green-500/25 disabled:opacity-40 transition-colors"
          >
            <ThumbsUp className="h-4 w-4" />
            Approve — Mark Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
