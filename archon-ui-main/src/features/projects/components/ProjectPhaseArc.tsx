import type React from "react";
import { cn } from "../../ui/primitives/styles";
import type { ProjectPhase } from "../types";

const PHASES: { label: string; phase: ProjectPhase; color: string; activeColor: string; pastColor: string }[] = [
  {
    label: "Analysis",
    phase: "analysis",
    color: "bg-zinc-800 border-zinc-600",
    activeColor: "bg-yellow-400 border-yellow-300",
    pastColor: "bg-yellow-900 border-yellow-700",
  },
  {
    label: "Planning",
    phase: "planning",
    color: "bg-zinc-800 border-zinc-600",
    activeColor: "bg-blue-400 border-blue-300",
    pastColor: "bg-blue-900 border-blue-700",
  },
  {
    label: "Solutioning",
    phase: "solutioning",
    color: "bg-zinc-800 border-zinc-600",
    activeColor: "bg-purple-400 border-purple-300",
    pastColor: "bg-purple-900 border-purple-700",
  },
  {
    label: "Implementation",
    phase: "implementation",
    color: "bg-zinc-800 border-zinc-600",
    activeColor: "bg-cyan-400 border-cyan-300",
    pastColor: "bg-cyan-900 border-cyan-700",
  },
];

function getPhaseIndex(phase: ProjectPhase): number {
  return PHASES.findIndex((p) => p.phase === phase);
}

interface ProjectPhaseArcProps {
  phase: ProjectPhase;
  className?: string;
}

export const ProjectPhaseArc: React.FC<ProjectPhaseArcProps> = ({ phase, className }) => {
  const currentPhaseIndex = getPhaseIndex(phase);

  return (
    <div className={cn("relative rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-6 py-4", className)}>
      <p className="text-center text-[10px] font-bold uppercase tracking-[0.35em] text-yellow-500/60 mb-4">
        BMAD Lifecycle
      </p>

      <div className="relative flex items-start">
        {/* Connecting line behind dots */}
        <div className="absolute top-[9px] left-[calc(12.5%)] right-[calc(12.5%)] h-px bg-zinc-700" />

        {PHASES.map((p, i) => {
          const isActive = i === currentPhaseIndex;
          const isPast = currentPhaseIndex > -1 && i < currentPhaseIndex;

          return (
            <div key={p.phase} className="relative flex-1 flex flex-col items-center gap-2">
              <div
                className={cn(
                  "w-[18px] h-[18px] rounded-full border-2 z-10 transition-all duration-500",
                  isActive ? p.activeColor : isPast ? p.pastColor : p.color,
                )}
              />
              <span
                className={cn(
                  "text-[10px] font-semibold uppercase tracking-wide text-center leading-tight",
                  isActive ? "text-yellow-400" : isPast ? "text-zinc-500" : "text-zinc-600",
                )}
              >
                {p.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
