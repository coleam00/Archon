import { Bot, User } from "lucide-react";
import type { Assignee } from "../types";

// Drag and drop constants
export const ItemTypes = {
  TASK: "task",
};

// Get icon for assignee
export const getAssigneeIcon = (assigneeName: Assignee) => {
  switch (assigneeName) {
    case "User":
      return <User className="w-4 h-4 text-blue-400" />;
    case "Coding Agent":
      return <Bot className="w-4 h-4 text-purple-400" />;
    case "Archon":
      return <img src="/logo-neon.png" alt="Archon" className="w-4 h-4" />;
    default:
      return <User className="w-4 h-4 text-blue-400" />;
  }
};

// Get glow effect for assignee
export const getAssigneeGlow = (assigneeName: Assignee) => {
  switch (assigneeName) {
    case "User":
      return "shadow-[0_0_10px_rgba(59,130,246,0.4)]";
    case "Coding Agent":
      return "shadow-[0_0_10px_rgba(168,85,247,0.4)]";
    case "Archon":
      return "shadow-[0_0_10px_rgba(34,211,238,0.4)]";
    default:
      return "shadow-[0_0_10px_rgba(59,130,246,0.4)]";
  }
};

// Get color based on task priority/order
export const getOrderColor = (order: number) => {
  if (order <= 3) return "bg-rose-500 dark:bg-rose-400";
  if (order <= 6) return "bg-orange-500 dark:bg-orange-400";
  if (order <= 10) return "bg-blue-500 dark:bg-blue-400";
  return "bg-green-500 dark:bg-green-400";
};

// Get glow effect based on task priority/order
export const getOrderGlow = (order: number) => {
  if (order <= 3) return "shadow-[0_0_10px_rgba(244,63,94,0.7)]";
  if (order <= 6) return "shadow-[0_0_10px_rgba(249,115,22,0.7)]";
  if (order <= 10) return "shadow-[0_0_10px_rgba(59,130,246,0.7)]";
  return "shadow-[0_0_10px_rgba(34,197,94,0.7)]";
};

// Get column header color based on status
export const getColumnColor = (status: "todo" | "doing" | "review" | "done") => {
  switch (status) {
    case "todo":
      return "text-gray-600 dark:text-gray-400";
    case "doing":
      return "text-blue-600 dark:text-blue-400";
    case "review":
      return "text-purple-600 dark:text-purple-400";
    case "done":
      return "text-green-600 dark:text-green-400";
  }
};

// Get column header glow based on status
export const getColumnGlow = (status: "todo" | "doing" | "review" | "done") => {
  switch (status) {
    case "todo":
      return "bg-gray-500/30 dark:bg-gray-400/40";
    case "doing":
      return "bg-blue-500/30 dark:bg-blue-400/40 shadow-[0_0_10px_2px_rgba(59,130,246,0.2)] dark:shadow-[0_0_10px_2px_rgba(96,165,250,0.3)]";
    case "review":
      return "bg-purple-500/30 dark:bg-purple-400/40 shadow-[0_0_10px_2px_rgba(168,85,247,0.2)] dark:shadow-[0_0_10px_2px_rgba(192,132,252,0.3)]";
    case "done":
      return "bg-green-500/30 dark:bg-green-400/40 shadow-[0_0_10px_2px_rgba(34,197,94,0.2)] dark:shadow-[0_0_10px_2px_rgba(74,222,128,0.3)]";
  }
};
