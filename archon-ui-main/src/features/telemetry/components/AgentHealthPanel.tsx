import { Users } from "lucide-react";
import type { TelemetryAgent, TelemetryAgentStatus } from "../types";

interface AgentHealthPanelProps {
  agents: TelemetryAgent[];
  isLoading: boolean;
}

const STATUS_CONFIG: Record<TelemetryAgentStatus, { label: string; dotClass: string; badgeClass: string }> = {
  active: {
    label: "active",
    dotClass: "bg-green-400",
    badgeClass: "text-green-400 bg-green-400/10 border-green-500/30",
  },
  busy: {
    label: "busy",
    dotClass: "bg-yellow-400",
    badgeClass: "text-yellow-400 bg-yellow-400/10 border-yellow-500/30",
  },
  inactive: {
    label: "inactive",
    dotClass: "bg-gray-500",
    badgeClass: "text-gray-400 bg-gray-700/50 border-gray-600/30",
  },
};

function formatLastSeen(secondsAgo: number): string {
  if (secondsAgo < 0) return "never";
  if (secondsAgo < 60) return `${secondsAgo}s ago`;
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)}m ago`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)}h ago`;
  return `${Math.floor(secondsAgo / 86400)}d ago`;
}

export function AgentHealthPanel({ agents, isLoading }: AgentHealthPanelProps) {
  return (
    <div className="bg-gray-900/50 border border-gray-700/50 rounded-xl backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <Users className="h-4 w-4 text-cyan-400" />
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Agent Health</h2>
        {!isLoading && (
          <span className="ml-auto text-xs text-gray-500">
            <span className="text-cyan-400 font-bold">{agents.length}</span> registered
          </span>
        )}
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-gray-800/50 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && agents.length === 0 && (
        <div className="flex items-center justify-center h-24 text-gray-500 text-sm">No agents registered</div>
      )}

      {!isLoading && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((agent) => {
            const cfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.inactive;
            return (
              <div
                key={agent.id}
                className="bg-gray-800/60 border border-gray-700/40 rounded-lg p-3 space-y-2"
              >
                {/* Name + status */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white truncate">{agent.name}</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${cfg.badgeClass}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${cfg.dotClass}`} />
                    {cfg.label}
                  </span>
                </div>

                {/* Role + last seen */}
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{agent.role ?? "—"}</span>
                  <span>{formatLastSeen(agent.last_seen_seconds_ago)}</span>
                </div>

                {/* Capabilities */}
                {agent.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.capabilities.slice(0, 4).map((cap) => (
                      <span
                        key={cap}
                        className="text-xs px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 truncate max-w-[100px]"
                        title={cap}
                      >
                        {cap}
                      </span>
                    ))}
                    {agent.capabilities.length > 4 && (
                      <span className="text-xs text-gray-500">+{agent.capabilities.length - 4}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
