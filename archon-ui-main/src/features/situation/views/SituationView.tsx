import { useQueryClient } from "@tanstack/react-query";
import { Brain, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { RecommendedActionCard } from "../components/RecommendedActionCard";
import { SystemHealthBadge } from "../components/SystemHealthBadge";
import { situationKeys, useAnalyzeSituation } from "../hooks/useSituationQueries";
import type { SituationBrief } from "../types";

export function SituationView() {
  const { mutate: runAnalysis, isPending } = useAnalyzeSituation();
  const queryClient = useQueryClient();
  const [lastRun, setLastRun] = useState<Date | null>(null);

  const brief = queryClient.getQueryData<SituationBrief>(situationKeys.latest());

  function handleRunAnalysis() {
    runAnalysis(undefined, {
      onSuccess: () => setLastRun(new Date()),
    });
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="h-6 w-6 text-cyan-400" />
          <div>
            <h1 className="text-xl font-bold text-gray-100">Situation Brief</h1>
            <p className="text-sm text-gray-500">
              {lastRun ? `Last run: ${lastRun.toLocaleTimeString()}` : "AI-powered daily system overview"}
            </p>
          </div>
        </div>
        <Button onClick={handleRunAnalysis} disabled={isPending} size="sm">
          <RefreshCw className={`h-4 w-4 mr-1.5 ${isPending ? "animate-spin" : ""}`} />
          {isPending ? "Analyzing…" : "Run Analysis"}
        </Button>
      </div>

      {/* Loading state */}
      {isPending && (
        <div className="flex items-center justify-center py-20 text-gray-500">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
            <p className="text-sm">Collecting state and generating brief… (5–15s)</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isPending && !brief && (
        <div className="flex items-center justify-center py-24 text-gray-500">
          <div className="text-center">
            <Brain className="h-12 w-12 text-gray-700 mx-auto mb-4" />
            <p className="text-sm font-medium text-gray-400">No brief yet</p>
            <p className="text-xs text-gray-600 mt-1">Click "Run Analysis" to generate your first situation brief.</p>
          </div>
        </div>
      )}

      {/* Brief content */}
      {!isPending && brief && (
        <div className="flex flex-col gap-6">
          {/* Summary */}
          <div className="p-4 rounded-lg bg-gray-900/50 border border-gray-700/50">
            <p className="text-sm text-gray-300 leading-relaxed">{brief.summary}</p>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg bg-gray-900/50 border border-gray-700/50 flex flex-col gap-1">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Active Tasks</p>
              <p className="text-2xl font-bold text-cyan-400">{brief.active_tasks.length}</p>
            </div>
            <div className="p-4 rounded-lg bg-gray-900/50 border border-gray-700/50 flex flex-col gap-1">
              <p className="text-xs text-gray-500 uppercase tracking-wider">System Health</p>
              <div className="mt-1">
                <SystemHealthBadge health={brief.system_health} />
              </div>
              {brief.system_health_notes && <p className="text-xs text-gray-600 mt-1">{brief.system_health_notes}</p>}
            </div>
            <div className="p-4 rounded-lg bg-gray-900/50 border border-gray-700/50 flex flex-col gap-1">
              <p className="text-xs text-gray-500 uppercase tracking-wider">Recent Activity</p>
              <p className="text-xs text-gray-400 leading-relaxed mt-1">{brief.recent_activity}</p>
            </div>
          </div>

          {/* Recommended Actions */}
          {brief.recommended_actions.length > 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Recommended Actions</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {brief.recommended_actions.slice(0, 3).map((action, i) => (
                  <RecommendedActionCard key={action.title} action={action} index={i} />
                ))}
              </div>
            </div>
          )}

          {/* Active tasks list */}
          {brief.active_tasks.length > 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Active Tasks (Top 5)</h2>
              <div className="flex flex-col gap-2">
                {brief.active_tasks.slice(0, 5).map((task) => (
                  <div
                    key={task.title}
                    className="flex items-center gap-3 px-3 py-2 rounded bg-gray-900/30 border border-gray-800/50"
                  >
                    <span
                      className={`inline-block w-2 h-2 rounded-full shrink-0 ${task.status === "doing" ? "bg-cyan-400" : "bg-gray-600"}`}
                    />
                    <span className="text-sm text-gray-300 truncate flex-1">{task.title}</span>
                    <span className="text-xs text-gray-600 capitalize shrink-0">{task.priority}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
