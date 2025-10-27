import { motion } from "framer-motion";
import { Activity, Clock, Monitor } from "lucide-react";
import type React from "react";
import { cn, compoundStyles, glassmorphism } from "../../ui/primitives";
import type { McpClient } from "../types";

interface McpClientListProps {
  clients: McpClient[];
  className?: string;
}

const clientIcons: Record<string, string> = {
  Claude: "🤖",
  Cursor: "💻",
  Windsurf: "🏄",
  Cline: "🔧",
  KiRo: "🚀",
  Augment: "⚡",
  Gemini: "🌐",
  Unknown: "❓",
};

export const McpClientList: React.FC<McpClientListProps> = ({ clients, className }) => {
  const formatDuration = (connectedAt: string): string => {
    const now = new Date();
    const connected = new Date(connectedAt);
    const seconds = Math.floor((now.getTime() - connected.getTime()) / 1000);

    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const formatLastActivity = (lastActivity: string): string => {
    const now = new Date();
    const activity = new Date(lastActivity);
    const seconds = Math.floor((now.getTime() - activity.getTime()) / 1000);

    if (seconds < 5) return "Active";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return "Idle";
  };

  if (clients.length === 0) {
    return (
      <div className={cn(compoundStyles.card, "p-6 text-center rounded-lg relative overflow-hidden", className)}>
        <div className="absolute top-3 right-3 px-2 py-1 bg-cyan-500/20 text-cyan-400 text-xs font-semibold rounded-full border border-cyan-500/30">
          Coming Soon
        </div>
        <Monitor className="w-12 h-12 mx-auto mb-3 text-zinc-500" />
        <p className="text-zinc-400">Client detection coming soon</p>
        <p className="text-sm text-zinc-500 mt-2">
          We'll automatically detect when AI assistants connect to the MCP server
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {clients.map((client, index) => (
        <motion.div
          key={client.session_id}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.1 }}
          className={cn(
            "flex items-center justify-between p-4 rounded-lg",
            glassmorphism.background.card,
            glassmorphism.border.default,
            client.status === "active" ? "border-green-500/50 shadow-[0_0_15px_rgba(34,197,94,0.2)]" : "",
          )}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">{clientIcons[client.client_type] || "❓"}</span>
            <div>
              <p className="font-medium text-white">{client.client_type}</p>
              <p className="text-xs text-zinc-400">Session: {client.session_id.slice(0, 8)}</p>
            </div>
          </div>

          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3 text-blue-400" />
              <span className="text-zinc-400">{formatDuration(client.connected_at)}</span>
            </div>

            <div className="flex items-center gap-1">
              <Activity className="w-3 h-3 text-green-400" />
              <span className={cn("text-zinc-400", client.status === "active" && "text-green-400")}>
                {formatLastActivity(client.last_activity)}
              </span>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
};
