/**
 * SessionEventCard Component
 *
 * Displays a single event in the session timeline with type-specific styling and icons.
 */

import { format } from "date-fns";
import { AlertTriangle, CheckCircle, Clock, FileCode, GitCommit, MessageSquare, XCircle, Zap } from "lucide-react";
import { cn } from "@/features/ui/primitives/styles";
import type { SessionEvent } from "../types";

interface SessionEventCardProps {
  event: SessionEvent;
  isFirst?: boolean;
  isLast?: boolean;
}

export function SessionEventCard({ event, isFirst, isLast }: SessionEventCardProps) {
  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case "task_completed":
      case "success":
        return <CheckCircle className="h-4 w-4 text-green-400" />;
      case "error":
      case "failed":
        return <XCircle className="h-4 w-4 text-red-400" />;
      case "warning":
        return <AlertTriangle className="h-4 w-4 text-yellow-400" />;
      case "code_change":
      case "file_modified":
        return <FileCode className="h-4 w-4 text-blue-400" />;
      case "git_commit":
        return <GitCommit className="h-4 w-4 text-purple-400" />;
      case "message":
      case "note":
        return <MessageSquare className="h-4 w-4 text-cyan-400" />;
      case "action":
      case "command":
        return <Zap className="h-4 w-4 text-yellow-400" />;
      default:
        return <Clock className="h-4 w-4 text-gray-400" />;
    }
  };

  const getEventColor = (eventType: string) => {
    switch (eventType) {
      case "task_completed":
      case "success":
        return "border-green-500/30 bg-green-500/5";
      case "error":
      case "failed":
        return "border-red-500/30 bg-red-500/5";
      case "warning":
        return "border-yellow-500/30 bg-yellow-500/5";
      case "code_change":
      case "file_modified":
        return "border-blue-500/30 bg-blue-500/5";
      case "git_commit":
        return "border-purple-500/30 bg-purple-500/5";
      case "message":
      case "note":
        return "border-cyan-500/30 bg-cyan-500/5";
      default:
        return "border-gray-700/50 bg-gray-800/30";
    }
  };

  const formatEventData = (data: Record<string, unknown> | null | undefined) => {
    if (!data) return null;
    const entries = Object.entries(data).filter(([key]) => !key.startsWith("_") && key !== "timestamp");

    if (entries.length === 0) return null;

    return (
      <div className="mt-2 space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-2 text-xs">
            <span className="text-gray-500 min-w-[100px] font-medium">{key.replace(/_/g, " ")}:</span>
            <span className="text-gray-300 flex-1 font-mono">
              {typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="relative flex gap-3">
      {/* Timeline Line */}
      {!isLast && <div className="absolute left-[11px] top-8 bottom-0 w-0.5 bg-gray-700/50" />}

      {/* Icon */}
      <div className="relative z-10 flex items-center justify-center w-6 h-6 rounded-full bg-gray-900 border border-gray-700">
        {getEventIcon(event.event_type)}
      </div>

      {/* Card */}
      <div className={cn("flex-1 rounded-lg border p-3 transition-colors", getEventColor(event.event_type))}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 space-y-1">
            {/* Event Type */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white">{event.event_type.replace(/_/g, " ")}</span>
              {isFirst && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  Latest
                </span>
              )}
            </div>

            {/* Event Data */}
            {formatEventData(event.data)}

            {/* Metadata */}
            {event.metadata && Object.keys(event.metadata).length > 0 && (
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Metadata</summary>
                <div className="mt-1 text-xs text-gray-400 font-mono bg-gray-900/50 rounded p-2">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(event.metadata, null, 2)}</pre>
                </div>
              </details>
            )}
          </div>

          {/* Timestamp */}
          <div className="text-xs text-gray-500 whitespace-nowrap">
            {format(new Date(event.timestamp), "h:mm:ss a")}
          </div>
        </div>
      </div>
    </div>
  );
}
