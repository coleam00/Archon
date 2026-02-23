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

interface RecommendedActionCardProps {
  action: RecommendedAction;
  index: number;
}

export function RecommendedActionCard({ action, index }: RecommendedActionCardProps) {
  const priorityClass = priorityClasses[action.priority] ?? priorityClasses.medium;
  return (
    <div className="flex flex-col gap-2 p-4 rounded-lg bg-gray-900/50 border border-gray-700/50 hover:border-cyan-500/30 transition-colors">
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
    </div>
  );
}
