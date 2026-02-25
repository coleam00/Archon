import { Check, ClipboardList, Copy } from "lucide-react";
import { useState } from "react";
import type { Agent } from "@/features/agents/types/agent";
import type { DatabaseTaskStatus, Task } from "@/features/projects/tasks/types";
import { TaskReviewModal } from "@/features/projects/tasks/components/TaskReviewModal";

const COLUMNS: { status: DatabaseTaskStatus; label: string; color: string }[] = [
  { status: "todo", label: "Todo", color: "text-gray-400 border-gray-500/30" },
  { status: "doing", label: "Doing", color: "text-yellow-400 border-yellow-500/30" },
  { status: "review", label: "Review", color: "text-blue-400 border-blue-500/30" },
  { status: "done", label: "Done", color: "text-green-400 border-green-500/30" },
];

const PRIORITY_COLORS = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-gray-500",
};

function buildPrompt(task: Task, agent: Agent | undefined): string {
  const role = agent?.role ?? task.assignee ?? "AI Agent";
  const capabilities = agent?.capabilities?.join(", ") ?? "";

  return `You are the ${role} agent in the Archon Agile AI team.${capabilities ? `\nCapabilities: ${capabilities}` : ""}

## Sprint Task

**Title:** ${task.title}
**Priority:** ${task.priority ?? "medium"}${task.description ? `\n**Description:** ${task.description}` : ""}${task.feature ? `\n**Area:** ${task.feature}` : ""}

## Instructions

Complete this task fully in the Archon project at ~/Documents/Projects/Archon.
When done, mark it complete:

  curl -s -X PUT http://localhost:8181/api/tasks/${task.id} \\
    -H "Content-Type: application/json" \\
    -d '{"status":"review"}'

Then confirm what was done in 1-2 sentences.`;
}

function buildReviewAgentPrompt(reviewTasks: Task[], agents: Agent[]): string {
  const reviewAgent = agents.find(
    (a) =>
      a.role &&
      (a.role.toLowerCase().includes("qa") ||
        a.role.toLowerCase().includes("reviewer") ||
        a.role.toLowerCase().includes("quality")),
  );
  const role = reviewAgent?.role ?? "QA / Reviewer Agent";
  const capabilities = reviewAgent?.capabilities?.join(", ") ?? "";

  const taskList = reviewTasks
    .map((t) => `- [${t.id}] ${t.title}${t.priority ? ` (${t.priority})` : ""}`)
    .join("\n");

  return `You are the ${role} in the Archon Agile AI team.${capabilities ? `\nCapabilities: ${capabilities}` : ""}

## Sprint Review Queue

The following tasks are awaiting your review:

${taskList}

## Instructions

For each task above, review the implementation thoroughly, then:

If approved — mark it done:
  curl -s -X PUT http://localhost:8181/api/tasks/{task_id} \\
    -H "Content-Type: application/json" \\
    -d '{"status":"done"}'

If rejected — send it back to doing:
  curl -s -X PUT http://localhost:8181/api/tasks/{task_id} \\
    -H "Content-Type: application/json" \\
    -d '{"status":"doing"}'

Start with the highest-priority task first. Confirm your review decision in 1-2 sentences per task.`;
}

interface ReviewAgentHintProps {
  reviewTasks: Task[];
  agents: Agent[];
}

function ReviewAgentHint({ reviewTasks, agents }: ReviewAgentHintProps) {
  const [copied, setCopied] = useState(false);

  function handleCopyReviewPrompt() {
    navigator.clipboard.writeText(buildReviewAgentPrompt(reviewTasks, agents)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // clipboard write failed — no-op
    });
  }

  return (
    <div className="flex flex-col gap-2 border border-dashed border-blue-500/30 rounded-lg px-3 py-3 bg-blue-500/5">
      <p className="text-[11px] text-blue-400/80 font-medium leading-tight">
        No backlog — {reviewTasks.length} task{reviewTasks.length !== 1 ? "s" : ""} awaiting review
      </p>
      <button
        type="button"
        onClick={handleCopyReviewPrompt}
        className="self-start flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded bg-blue-900/50 text-blue-300 border border-blue-700/40 hover:bg-blue-800/50 transition-colors"
      >
        {copied ? <Check className="w-3 h-3" /> : <ClipboardList className="w-3 h-3" />}
        {copied ? "Copied" : "Copy review prompt"}
      </button>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  agent: Agent | undefined;
  isReview?: boolean;
  onReviewClick?: (task: Task) => void;
}

function TaskCard({ task, agent, isReview = false, onReviewClick }: TaskCardProps) {
  const [copied, setCopied] = useState(false);
  const priorityColor = PRIORITY_COLORS[task.priority] ?? PRIORITY_COLORS.medium;

  const initials = task.assignee
    ? task.assignee
        .split(/[\s-_]/)
        .map((w) => w[0] ?? "")
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(buildPrompt(task, agent)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // clipboard write failed — no-op
    });
  }

  return (
    <div
      className={[
        "group bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 space-y-2 transition-colors",
        isReview
          ? "cursor-pointer hover:border-blue-500/50 hover:bg-zinc-800/80 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          : "cursor-default hover:border-zinc-600",
      ].join(" ")}
      role={isReview ? "button" : undefined}
      tabIndex={isReview ? 0 : undefined}
      onClick={isReview && onReviewClick ? () => onReviewClick(task) : undefined}
      onKeyDown={
        isReview && onReviewClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onReviewClick(task);
              }
            }
          : undefined
      }
    >
      <div className="flex items-start gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${priorityColor} shrink-0 mt-1.5`} />
        <p className="text-sm text-white font-medium line-clamp-2 flex-1">{task.title}</p>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{task.feature || ""}</span>
        <div className="flex items-center gap-1.5">
          {/* Copy prompt button — visible on hover */}
          <button
            type="button"
            onClick={handleCopy}
            title="Copy agent prompt"
            className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-cyan-900/60 text-cyan-400 border border-cyan-700/40 hover:bg-cyan-800/60"
          >
            {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
            {copied ? "Copied" : "Prompt"}
          </button>
          <div
            className="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center text-[9px] font-bold text-gray-300"
            title={task.assignee}
          >
            {initials}
          </div>
        </div>
      </div>

      {/* Review hint */}
      {isReview && (
        <div className="pt-1 border-t border-zinc-700/40">
          <p className="text-[10px] text-blue-400/70 font-medium">Click to review →</p>
        </div>
      )}
    </div>
  );
}

interface SprintKanbanProps {
  tasks: Task[];
  agents?: Agent[];
  projectId: string;
}

export function SprintKanban({ tasks, agents = [], projectId }: SprintKanbanProps) {
  const [reviewTask, setReviewTask] = useState<Task | null>(null);

  const tasksByStatus = Object.fromEntries(
    COLUMNS.map((col) => [col.status, tasks.filter((t) => t.status === col.status)]),
  ) as Record<DatabaseTaskStatus, Task[]>;

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 border border-dashed border-zinc-700 rounded-xl">
        <p className="text-gray-500 text-sm">No tasks assigned to this sprint</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {COLUMNS.map((col) => {
          const colTasks = tasksByStatus[col.status] ?? [];
          const isReview = col.status === "review";
          const isTodo = col.status === "todo";
          const reviewTasks = tasksByStatus["review"] ?? [];
          const showReviewHint = isTodo && colTasks.length === 0 && reviewTasks.length > 0;
          return (
            <div key={col.status} className="space-y-2">
              {/* Column header */}
              <div className={`flex items-center gap-2 pb-2 border-b ${col.color}`}>
                <span className={`text-sm font-semibold flex-1 ${col.color.split(" ")[0]}`}>{col.label}</span>
                {isReview && colTasks.length > 0 && (
                  <span className="text-[9px] font-bold uppercase tracking-wider text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5">
                    PO gate
                  </span>
                )}
                <span className="text-xs text-gray-500 font-medium">{colTasks.length}</span>
              </div>
              {/* Tasks */}
              <div className="space-y-2">
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    agent={agents.find((a) => a.name === task.assignee)}
                    isReview={isReview}
                    onReviewClick={setReviewTask}
                  />
                ))}
                {showReviewHint && (
                  <ReviewAgentHint reviewTasks={reviewTasks} agents={agents} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {reviewTask && (
        <TaskReviewModal
          task={reviewTask}
          projectId={projectId}
          onClose={() => setReviewTask(null)}
        />
      )}
    </>
  );
}
