import { BarChart2, RefreshCw } from "lucide-react";
import { AgentHealthPanel } from "../components/AgentHealthPanel";
import { HandoffPipelinePanel } from "../components/HandoffPipelinePanel";
import { SessionActivityPanel } from "../components/SessionActivityPanel";
import { useRecentSessions, useTelemetryHandoffs, useTelemetrySnapshot } from "../hooks/useTelemetryQueries";

function formatLastRefreshed(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  return `${Math.floor(diff / 60)}m ago`;
}

export function TelemetryView() {
  const {
    data: snapshot,
    isLoading: snapshotLoading,
    dataUpdatedAt: snapshotUpdatedAt,
    refetch: refetchSnapshot,
  } = useTelemetrySnapshot();

  const { data: sessions = [], isLoading: sessionsLoading, refetch: refetchSessions } = useRecentSessions();
  const { data: handoffs = [], isLoading: handoffsLoading, refetch: refetchHandoffs } = useTelemetryHandoffs();

  const agents = snapshot?.agents ?? [];
  const lastUpdated = snapshotUpdatedAt ? formatLastRefreshed(snapshotUpdatedAt) : "—";

  function handleRefresh() {
    refetchSnapshot();
    refetchSessions();
    refetchHandoffs();
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <BarChart2 className="h-6 w-6 text-cyan-400" />
            Telemetry
          </h1>
          <p className="text-sm text-gray-400 mt-1">Live agent health, session activity, and handoff pipeline</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            refreshed{" "}
            <span className="text-gray-400">{lastUpdated}</span>
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md text-gray-400 hover:text-cyan-400 hover:bg-cyan-500/10 border border-gray-700/50 hover:border-cyan-500/30 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Agent Health — full row */}
      <AgentHealthPanel agents={agents} isLoading={snapshotLoading} />

      {/* Session Activity + Handoff Pipeline — side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SessionActivityPanel sessions={sessions} isLoading={sessionsLoading} />
        <HandoffPipelinePanel handoffs={handoffs} isLoading={handoffsLoading} />
      </div>
    </div>
  );
}
