import { Activity } from "lucide-react";
import type { Session } from "../../sessions/types";

interface SessionActivityPanelProps {
  sessions: Session[];
  isLoading: boolean;
}

const AGENT_COLORS: Record<string, string> = {
  claude: "text-blue-400",
  gemini: "text-purple-400",
  gpt: "text-green-400",
  user: "text-orange-400",
};

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function SessionActivityPanel({ sessions, isLoading }: SessionActivityPanelProps) {
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
  const recent = sorted.slice(0, 10);

  return (
    <div className="bg-gray-900/50 border border-gray-700/50 rounded-xl backdrop-blur-sm p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="h-4 w-4 text-cyan-400" />
        <h2 className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Session Activity</h2>
        {!isLoading && (
          <span className="ml-auto text-xs text-gray-500">
            <span className="text-cyan-400 font-bold">{sessions.filter((s) => !s.ended_at).length}</span> active
          </span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 bg-gray-800/50 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && sessions.length === 0 && (
        <div className="flex items-center justify-center flex-1 text-gray-500 text-sm">No sessions found</div>
      )}

      {!isLoading && recent.length > 0 && (
        <div className="space-y-2 overflow-y-auto">
          {recent.map((session) => {
            const isActive = !session.ended_at;
            const agentColor = AGENT_COLORS[session.agent] ?? "text-gray-400";
            return (
              <div
                key={session.id}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-cyan-500/10 border border-cyan-500/20"
                    : "bg-gray-800/40 border border-gray-700/30"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isActive && <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shrink-0" />}
                  {!isActive && <span className="h-2 w-2 rounded-full bg-gray-600 shrink-0" />}
                  <span className={`font-medium shrink-0 ${agentColor}`}>{session.agent}</span>
                  {session.summary && (
                    <span className="text-gray-500 truncate text-xs">{session.summary}</span>
                  )}
                </div>
                <span className="text-xs text-gray-500 shrink-0">{formatRelativeTime(session.started_at)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
