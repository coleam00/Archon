import { Users } from "lucide-react";
import { useTelemetrySnapshot } from "../hooks/useTelemetryQueries";
import type { TelemetryAgentStatus } from "../types";

const STATUS_DOT: Record<TelemetryAgentStatus, string> = {
  active: "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]",
  busy: "bg-yellow-400 shadow-[0_0_6px_rgba(250,204,21,0.6)]",
  inactive: "bg-gray-600",
};

const STATUS_BADGE: Record<TelemetryAgentStatus, string> = {
  active: "text-green-400 bg-green-400/10 border-green-500/30",
  busy: "text-yellow-400 bg-yellow-400/10 border-yellow-500/30",
  inactive: "text-gray-500 bg-gray-700/30 border-gray-600/30",
};

function formatLastSeen(secondsAgo: number): string {
  if (secondsAgo < 0) return "never";
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}

export function AgentHealthGrid() {
  const { data: snapshot, isLoading } = useTelemetrySnapshot();
  const agents = snapshot?.agents ?? [];

  const activeCount = agents.filter((a) => a.status === "active").length;

  return (
    <div className="bg-gray-900/50 border border-gray-700/50 rounded-xl backdrop-blur-sm p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-4 w-4 text-cyan-400" />
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Agent Health</h2>
        {!isLoading && agents.length > 0 && (
          <span className="ml-auto text-xs text-gray-500">
            <span className="text-green-400 font-bold">{activeCount}</span>
            <span className="text-gray-600"> / {agents.length} active</span>
          </span>
        )}
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-24 bg-gray-800/50 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!isLoading && agents.length === 0 && (
        <div className="flex items-center justify-center h-24 text-gray-500 text-sm">No agents registered</div>
      )}

      {/* 5-card grid */}
      {!isLoading && agents.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {agents.map((agent) => {
            const dotClass = STATUS_DOT[agent.status] ?? STATUS_DOT.inactive;
            const badgeClass = STATUS_BADGE[agent.status] ?? STATUS_BADGE.inactive;

            return (
              <div
                key={agent.id}
                className="flex flex-col gap-2 bg-gray-800/60 border border-gray-700/40 rounded-lg p-3 hover:border-gray-600/60 transition-colors"
              >
                {/* Status dot + name */}
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 h-2 w-2 rounded-full ${dotClass}`} />
                  <span className="text-sm font-semibold text-white truncate">{agent.name}</span>
                </div>

                {/* Role badge */}
                <span
                  className={`self-start inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border ${badgeClass}`}
                >
                  {agent.status}
                </span>

                {/* Role label */}
                {agent.role && (
                  <span className="text-[11px] text-gray-500 truncate" title={agent.role}>
                    {agent.role}
                  </span>
                )}

                {/* Last seen */}
                <span className="mt-auto text-[11px] text-gray-600 tabular-nums">
                  {formatLastSeen(agent.last_seen_seconds_ago)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
