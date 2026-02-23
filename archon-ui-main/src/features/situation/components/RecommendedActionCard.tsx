import { Check, ClipboardCopy, Plus } from "lucide-react";
import { useState } from "react";
import { useCreateTaskFromAction } from "../hooks/useSituationQueries";
import type { RecommendedAction } from "../types";

const priorityClasses: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border border-red-500/30",
  high: "bg-orange-500/20 text-orange-400 border border-orange-500/30",
  medium: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  low: "bg-gray-500/20 text-gray-400 border border-gray-500/30",
};

const effortLabels: Record<string, string> = {
  quick: "Quick",
  moderate: "Moderate",
  significant: "Significant effort",
};

const AGENTS = ["claude", "gemini", "gpt", "user"] as const;
type Agent = (typeof AGENTS)[number];

interface RecommendedActionCardProps {
  action: RecommendedAction;
  index: number;
}

export function RecommendedActionCard({ action, index }: RecommendedActionCardProps) {
  const priorityClass = priorityClasses[action.priority] ?? priorityClasses.medium;
  const [copied, setCopied] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<Agent>("claude");
  const [taskCreated, setTaskCreated] = useState(false);

  const { mutate: createTask, isPending: isCreating } = useCreateTaskFromAction();

  function handleCopyPrompt() {
    const prompt = [
      `# ${action.title}`,
      "",
      action.description,
      "",
      `**Priority:** ${action.priority} | **Effort:** ${effortLabels[action.estimated_effort] ?? action.estimated_effort}`,
      `**Why now:** ${action.why}`,
    ].join("\n");

    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleConfirmCreate() {
    createTask(
      { action, assignee: selectedAgent },
      {
        onSuccess: () => {
          setShowAgentPicker(false);
          setTaskCreated(true);
          setTimeout(() => setTaskCreated(false), 3000);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 rounded-lg bg-gray-900/50 border border-gray-700/50 hover:border-cyan-500/30 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-600">#{index + 1}</span>
          <h3 className="text-sm font-semibold text-gray-100">{action.title}</h3>
        </div>
        <span
          className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${priorityClass}`}
        >
          {action.priority}
        </span>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">{action.description}</p>
      <p className="text-xs text-cyan-400/70 italic">{action.why}</p>

      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs text-gray-600 capitalize">{action.type}</span>
        <span className="text-gray-700">·</span>
        <span className="text-xs text-gray-600">
          {effortLabels[action.estimated_effort] ?? action.estimated_effort}
        </span>
      </div>

      {/* Agent picker (inline, shown when Create Task is clicked) */}
      {showAgentPicker && (
        <div className="flex flex-col gap-2 pt-2 border-t border-gray-800/50">
          <p className="text-xs text-gray-500">Assign to:</p>
          <div className="flex flex-wrap gap-1.5">
            {AGENTS.map((agent) => (
              <button
                key={agent}
                type="button"
                onClick={() => setSelectedAgent(agent)}
                className={`px-2.5 py-1 rounded text-xs transition-colors ${
                  selectedAgent === agent
                    ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                    : "bg-gray-800/50 text-gray-400 border border-gray-700/50 hover:border-gray-600"
                }`}
              >
                {agent}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirmCreate}
              disabled={isCreating}
              className="px-3 py-1 text-xs rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors disabled:opacity-50"
            >
              {isCreating ? "Creating…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setShowAgentPicker(false)}
              className="px-3 py-1 text-xs rounded text-gray-500 hover:text-gray-400 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!showAgentPicker && (
        <div className="flex items-center gap-2 pt-2 border-t border-gray-800/50">
          {taskCreated ? (
            <span className="flex items-center gap-1 text-xs text-emerald-400">
              <Check className="h-3 w-3" />
              Task created
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setShowAgentPicker(true)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-cyan-400 transition-colors"
            >
              <Plus className="h-3 w-3" />
              Create Task
            </button>
          )}
          <span className="text-gray-800">·</span>
          <button
            type="button"
            onClick={handleCopyPrompt}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-cyan-400 transition-colors"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <ClipboardCopy className="h-3 w-3" />
                Copy Prompt
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
