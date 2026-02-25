import { Swords } from "lucide-react";
import { useEffect, useState } from "react";
import { useAgents } from "@/features/agents/hooks/useAgentQueries";
import { useHandoffs } from "@/features/handoffs/hooks/useHandoffQueries";
import { useProjects } from "@/features/projects/hooks/useProjectQueries";
import { useAllDoingTasks, useProjectTasks } from "@/features/projects/tasks/hooks/useTaskQueries";
import { AgentWarCard } from "../components/AgentWarCard";
import { SprintHeader } from "../components/SprintHeader";
import { SprintKanban } from "../components/SprintKanban";
import { SprintSelector } from "../components/SprintSelector";
import { SprintVelocityPanel } from "../components/SprintVelocityPanel";
import { useProjectSprints } from "../hooks/useSprintQueries";
import type { Sprint, SprintStatus } from "../types";

// Scrum sprint phases — maps sprint status to phase index
const SPRINT_PHASES: { label: string; statuses: SprintStatus[] }[] = [
  { label: "Planning", statuses: ["planning"] },
  { label: "PO Approval", statuses: ["ready_for_kickoff"] },
  { label: "Execution", statuses: ["active"] },
  { label: "Review", statuses: ["completed"] },
];

function getPhaseIndex(status: SprintStatus): number {
  return SPRINT_PHASES.findIndex((p) => p.statuses.includes(status));
}

interface SprintPhaseArcProps {
  status: SprintStatus;
}

function SprintPhaseArc({ status }: SprintPhaseArcProps) {
  const currentPhase = getPhaseIndex(status);

  return (
    <div className="relative rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-6 py-4">
      {/* Label */}
      <p className="text-center text-[10px] font-bold uppercase tracking-[0.35em] text-cyan-500/60 mb-4">
        Scrum Sprint
      </p>

      {/* Phase track */}
      <div className="relative flex items-start">
        {/* Connecting line behind dots */}
        <div className="absolute top-[9px] left-[calc(12.5%)] right-[calc(12.5%)] h-px bg-zinc-700" />

        {SPRINT_PHASES.map((phase, i) => {
          const isActive = i === currentPhase;
          const isPast = currentPhase > -1 && i < currentPhase;
          return (
            <div key={phase.label} className="relative flex-1 flex flex-col items-center gap-2">
              {/* Dot */}
              <div
                className={[
                  "w-[18px] h-[18px] rounded-full border-2 z-10 transition-all duration-500",
                  isActive
                    ? "bg-cyan-400 border-cyan-300 sprint-phase-active-dot"
                    : isPast
                      ? "bg-cyan-900 border-cyan-700"
                      : "bg-zinc-800 border-zinc-600",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              {/* Label */}
              <span
                className={[
                  "text-[10px] font-semibold uppercase tracking-wide text-center leading-tight",
                  isActive ? "text-cyan-400" : isPast ? "text-zinc-500" : "text-zinc-600",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {phase.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const LS_PROJECT_KEY = "war-room:projectId";
const LS_SPRINT_KEY = "war-room:sprintId";

export function SprintWarRoomView() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => localStorage.getItem(LS_PROJECT_KEY));
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(() => localStorage.getItem(LS_SPRINT_KEY));

  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: sprints = [], isLoading: sprintsLoading } = useProjectSprints(selectedProjectId ?? undefined);
  const { data: agents = [] } = useAgents();
  const { data: allTasks = [] } = useProjectTasks(selectedProjectId ?? undefined, !!selectedProjectId);
  const { data: pendingHandoffs = [] } = useHandoffs({ status: "pending" });
  const { data: allDoingTasks = [] } = useAllDoingTasks();

  // Persist selections to localStorage
  useEffect(() => {
    if (selectedProjectId) localStorage.setItem(LS_PROJECT_KEY, selectedProjectId);
  }, [selectedProjectId]);
  useEffect(() => {
    if (selectedSprintId) localStorage.setItem(LS_SPRINT_KEY, selectedSprintId);
    else localStorage.removeItem(LS_SPRINT_KEY);
  }, [selectedSprintId]);

  // Auto-select first non-archived project when nothing persisted or persisted ID is no longer valid
  useEffect(() => {
    if (projects.length > 0) {
      const isValid = selectedProjectId && projects.some((p) => p.id === selectedProjectId);
      if (!isValid) {
        const first = projects.find((p) => !p.archived) ?? projects[0];
        if (first) setSelectedProjectId(first.id);
      }
    }
  }, [projects, selectedProjectId]);

  // Auto-select active sprint, falling back to first sprint
  useEffect(() => {
    if (sprintsLoading) return; // preserve persisted selection while sprints are loading
    if (sprints.length === 0) {
      setSelectedSprintId(null);
      return;
    }
    const active = sprints.find((s: Sprint) => s.status === "active");
    const current = sprints.find((s: Sprint) => s.id === selectedSprintId);
    if (!current) {
      setSelectedSprintId((active ?? sprints[0]).id);
    }
  }, [sprints, selectedSprintId, sprintsLoading]);

  const selectedSprint = sprints.find((s: Sprint) => s.id === selectedSprintId);
  const sprintTasks = selectedSprintId ? allTasks.filter((t) => t.sprint_id === selectedSprintId) : [];

  if (projectsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Swords className="h-8 w-8 text-cyan-400 animate-pulse mx-auto mb-2" />
          <p className="text-gray-400 text-sm">Loading war room…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Swords className="h-6 w-6 text-cyan-400" />
            Sprint War Room
          </h1>
          <p className="text-sm text-gray-400 mt-1">Self-Organizing · Cross-Functional · Agile-Compliant</p>
        </div>
      </div>

      {/* Project + Sprint selectors */}
      <SprintSelector
        projects={projects.filter((p) => !p.archived)}
        selectedProjectId={selectedProjectId}
        selectedSprintId={selectedSprintId}
        onProjectChange={(id) => {
          setSelectedProjectId(id);
          setSelectedSprintId(null);
          localStorage.removeItem(LS_SPRINT_KEY);
        }}
        onSprintChange={setSelectedSprintId}
        onSprintCreated={setSelectedSprintId}
      />

      {/* Sprint phase arc */}
      {selectedSprint && <SprintPhaseArc status={selectedSprint.status} />}

      {/* Sprint header */}
      {selectedSprint ? (
        <SprintHeader sprint={selectedSprint} tasks={sprintTasks} isProductOwner={true} />
      ) : (
        <div className="flex items-center justify-center h-24 border border-dashed border-zinc-700 rounded-xl">
          <p className="text-gray-500 text-sm">
            {selectedProjectId ? "No sprints yet — create one to get started" : "Select a project to begin"}
          </p>
        </div>
      )}

      {selectedSprint && (
        <>
          {/* Agent cards grid */}
          {agents.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-bold text-gray-500 uppercase tracking-[0.2em]">Agile AI Team</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {[...agents].sort((a, b) => a.name.localeCompare(b.name)).map((agent) => (
                  <AgentWarCard
                    key={agent.id}
                    agent={agent}
                    sprintTasks={sprintTasks}
                    doingTasks={allDoingTasks}
                    pendingHandoffs={pendingHandoffs}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Sprint kanban — styled as holographic board */}
          <section className="space-y-3">
            <h2 className="text-xs font-bold text-gray-500 uppercase tracking-[0.2em]">Sprint Board</h2>
            <div className="holographic-board rounded-xl p-4">
              <SprintKanban tasks={sprintTasks} agents={agents} projectId={selectedProjectId ?? ""} />
            </div>
          </section>

          {/* Velocity panel — burn-down chart */}
          <section className="space-y-3">
            <h2 className="text-xs font-bold text-gray-500 uppercase tracking-[0.2em]">Sprint Velocity</h2>
            <SprintVelocityPanel sprint={selectedSprint} tasks={sprintTasks} />
          </section>
        </>
      )}
    </div>
  );
}
