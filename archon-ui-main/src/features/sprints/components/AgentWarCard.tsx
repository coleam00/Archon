import { ArrowRight } from "lucide-react";
import type { Agent } from "@/features/agents/types";
import type { Handoff } from "@/features/handoffs/types";
import type { Task } from "@/features/projects/tasks/types";

// Role-based visual config — matched by role text keywords (highest priority)
const ROLE_CONFIGS: Array<{
  keywords: string[];
  bg: string;
  text: string;
  ring: string;
  emoji: string;
  glowRgb: string;
  tagline: string;
}> = [
  {
    keywords: ["product owner", " po "],
    bg: "bg-slate-300/10",
    text: "text-slate-200",
    ring: "ring-slate-300/40",
    emoji: "👑",
    glowRgb: "203,213,225",
    tagline: "Prioritizes · Vision",
  },
  {
    keywords: ["scrum master"],
    bg: "bg-orange-500/15",
    text: "text-orange-300",
    ring: "ring-orange-400/40",
    emoji: "⚡",
    glowRgb: "251,146,60",
    tagline: "Guides · Removes Blocks",
  },
  {
    keywords: ["developer", "engineer", "software", "coder"],
    bg: "bg-red-500/15",
    text: "text-red-400",
    ring: "ring-red-400/40",
    emoji: "💻",
    glowRgb: "239,68,68",
    tagline: "Builds · Codes",
  },
  {
    keywords: ["qa", "tester", "quality", "reviewer"],
    bg: "bg-purple-500/15",
    text: "text-purple-400",
    ring: "ring-purple-400/40",
    emoji: "🔍",
    glowRgb: "168,85,247",
    tagline: "Tests · Validates",
  },
  {
    keywords: ["tech lead", "lead", "architect"],
    bg: "bg-cyan-500/15",
    text: "text-cyan-400",
    ring: "ring-cyan-400/40",
    emoji: "🏗️",
    glowRgb: "34,211,238",
    tagline: "Architects · Leads",
  },
  {
    keywords: ["designer", "ux", "ui"],
    bg: "bg-pink-500/15",
    text: "text-pink-400",
    ring: "ring-pink-400/40",
    emoji: "🎨",
    glowRgb: "244,114,182",
    tagline: "Designs · Creates",
  },
];

// Fallback: match by AI engine name when no role is set
const AGENT_ENGINE_FALLBACK: Record<
  string,
  { bg: string; text: string; ring: string; emoji: string; glowRgb: string; tagline: string }
> = {
  claude: {
    bg: "bg-orange-500/15",
    text: "text-orange-400",
    ring: "ring-orange-500/40",
    emoji: "🔥",
    glowRgb: "249,115,22",
    tagline: "Claude · Orchestrator",
  },
  "claude-opus": {
    bg: "bg-cyan-500/15",
    text: "text-cyan-400",
    ring: "ring-cyan-500/40",
    emoji: "🏗️",
    glowRgb: "6,182,212",
    tagline: "Claude Opus · Tech Lead",
  },
  "claude-sonnet": {
    bg: "bg-blue-500/15",
    text: "text-blue-400",
    ring: "ring-blue-500/40",
    emoji: "🔍",
    glowRgb: "59,130,246",
    tagline: "Claude Sonnet · Reviewer",
  },
  "claude-haiku": {
    bg: "bg-green-500/15",
    text: "text-green-400",
    ring: "ring-green-500/40",
    emoji: "⚡",
    glowRgb: "34,197,94",
    tagline: "Claude Haiku · Planner",
  },
  user: {
    bg: "bg-purple-500/15",
    text: "text-purple-400",
    ring: "ring-purple-500/40",
    emoji: "👤",
    glowRgb: "168,85,247",
    tagline: "Human Agent",
  },
};

const STATUS_CONFIG = {
  active: { label: "Active", className: "bg-green-500/20 text-green-400 border-green-500/30" },
  busy: { label: "Busy", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  inactive: { label: "Idle", className: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
};

function getVisualConfig(agent: Agent) {
  if (agent.role) {
    const roleLower = agent.role.toLowerCase();
    for (const cfg of ROLE_CONFIGS) {
      if (cfg.keywords.some((kw) => roleLower.includes(kw))) {
        return { ...cfg, displayRole: agent.role, tagline: cfg.tagline };
      }
    }
  }
  const nameLower = agent.name.toLowerCase();
  for (const [key, cfg] of Object.entries(AGENT_ENGINE_FALLBACK)) {
    if (nameLower.includes(key)) return { ...cfg, displayRole: agent.role ?? agent.name, tagline: cfg.tagline };
  }
  return {
    bg: "bg-zinc-500/15",
    text: "text-zinc-300",
    ring: "ring-zinc-500/40",
    emoji: "🤖",
    glowRgb: "161,161,170",
    displayRole: agent.role ?? agent.name,
    tagline: "AI Agent",
  };
}


function TypingIndicator() {
  return (
    <div className="flex items-center gap-0.5 ml-0.5" aria-hidden="true">
      {([0, 1, 2] as const).map((i) => (
        <span
          key={i}
          className="agent-typing-dot inline-block w-1 h-1 rounded-full bg-yellow-400"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </div>
  );
}

interface AgentWarCardProps {
  agent: Agent;
  sprintTasks: Task[];
  doingTasks?: Task[];
  pendingHandoffs: Handoff[];
}

export function AgentWarCard({ agent, sprintTasks, doingTasks, pendingHandoffs }: AgentWarCardProps) {
  const cfg = getVisualConfig(agent);
  const statusConfig = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.inactive;

  const isActive = agent.status === "active";
  const isBusy = agent.status === "busy";
  const isIdle = agent.status === "inactive";

  // Use global doing tasks when available so active work shows regardless of selected sprint
  const currentTask = (doingTasks ?? sprintTasks).find((t) => t.assignee === agent.name && t.status === "doing");
  const pendingHandoff = pendingHandoffs.find((h) => h.from_agent === agent.name);

  const rowGlow = isActive
    ? { boxShadow: `0 0 10px 1px rgba(${cfg.glowRgb}, 0.2)` }
    : isBusy
      ? { boxShadow: `0 0 6px 1px rgba(${cfg.glowRgb}, 0.12)` }
      : undefined;

  return (
    <div
      className={[
        "flex flex-col gap-1.5 bg-zinc-900/70 border rounded-xl px-3 py-2.5 transition-[opacity,border-color] duration-200",
        pendingHandoff ? "ring-1 ring-yellow-500/30" : "",
        isActive ? "agent-card-active" : "",
        isBusy ? "agent-card-busy" : "",
        isIdle ? "opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          borderColor: `rgba(${cfg.glowRgb}, 0.2)`,
          "--agent-glow-rgb": cfg.glowRgb,
          ...rowGlow,
        } as React.CSSProperties
      }
    >
      {/* Line 1: emoji + name + status badge + indicators */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm leading-none shrink-0">{cfg.emoji}</span>
        <span className={`text-xs font-bold truncate ${cfg.text}`}>{agent.name}</span>
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusConfig.className}`}
          >
            {statusConfig.label}
          </span>
          {isBusy && <TypingIndicator />}
          {pendingHandoff && <ArrowRight className="h-3 w-3 text-yellow-400 shrink-0" />}
        </div>
      </div>

      {/* Line 2: current task or idle */}
      {currentTask ? (
        <p className="text-[11px] text-gray-300 truncate leading-tight">
          <span className="text-gray-500">Working on:</span> {currentTask.title}
        </p>
      ) : (
        <p className="text-[11px] text-gray-600 italic leading-tight">No active task</p>
      )}
    </div>
  );
}
