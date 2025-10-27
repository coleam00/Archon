import { AlertCircle, CheckCircle, Clock, Server, Users } from "lucide-react";
import type React from "react";
import { cn, glassmorphism } from "../../ui/primitives";
import type { McpServerConfig, McpServerStatus, McpSessionInfo } from "../types";

interface McpStatusBarProps {
  status: McpServerStatus;
  sessionInfo?: McpSessionInfo;
  config?: McpServerConfig;
  className?: string;
}

export const McpStatusBar: React.FC<McpStatusBarProps> = ({ status, sessionInfo, config, className }) => {
  const formatUptime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      return `${days}d ${hours % 24}h ${minutes}m`;
    }
    return `${hours}h ${minutes}m ${secs}s`;
  };

  const getStatusIcon = () => {
    if (status.status === "running") {
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
    return <AlertCircle className="w-4 h-4 text-red-500" />;
  };

  const getStatusColor = () => {
    if (status.status === "running") {
      return "text-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]";
    }
    return "text-red-500";
  };

  return (
    <div
      className={cn(
        "flex items-center gap-6 px-4 py-2 rounded-lg",
        glassmorphism.background.subtle,
        glassmorphism.border.default,
        "font-mono text-sm",
        className,
      )}
    >
      {/* Status Indicator */}
      <div className="flex items-center gap-2">
        {getStatusIcon()}
        <span className={cn("font-semibold", getStatusColor())}>{status.status.toUpperCase()}</span>
      </div>

      {/* Separator */}
      <div className="w-px h-4 bg-zinc-700" />

      {/* Uptime */}
      {status.uptime !== null && (
        <>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-500" />
            <span className="text-zinc-400">UP</span>
            <span className="text-white">{formatUptime(status.uptime)}</span>
          </div>
          <div className="w-px h-4 bg-zinc-700" />
        </>
      )}

      {/* Server Info */}
      <div className="flex items-center gap-2">
        <Server className="w-4 h-4 text-cyan-500" />
        <span className="text-zinc-400">MCP</span>
        <span className="text-white">8051</span>
      </div>

      {/* Active Sessions */}
      {sessionInfo && (
        <>
          <div className="w-px h-4 bg-zinc-700" />
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-pink-500" />
            <span className="text-zinc-400">SESSIONS</span>
            <span className="text-cyan-400 text-sm">Coming Soon</span>
          </div>
        </>
      )}

      {/* Transport Type */}
      <div className="w-px h-4 bg-zinc-700 ml-auto" />
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">TRANSPORT</span>
        <span className="text-cyan-400">
          {config?.transport === "streamable-http"
            ? "HTTP"
            : config?.transport === "sse"
              ? "SSE"
              : config?.transport || "HTTP"}
        </span>
      </div>
    </div>
  );
};
