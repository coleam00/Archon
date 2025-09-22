import { motion } from "framer-motion";
import { Activity, CheckCircle2, ListTodo } from "lucide-react";
import type React from "react";
import { isOptimistic } from "@/features/shared/utils/optimistic";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { cn } from "../../ui/primitives/styles";
import type { Project } from "../types";
import { ProjectCardActions } from "./ProjectCardActions";

interface ProjectCardProps {
  project: Project;
  isSelected: boolean;
  taskCounts: {
    todo: number;
    doing: number;
    review: number;
    done: number;
  };
  onSelect: (project: Project) => void;
  onPin: (e: React.MouseEvent, projectId: string) => void;
  onDelete: (e: React.MouseEvent, projectId: string, title: string) => void;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  isSelected,
  taskCounts,
  onSelect,
  onPin,
  onDelete,
}) => {
  // Check if project is optimistic
  const optimistic = isOptimistic(project);

  return (
    <motion.div
      tabIndex={0}
      aria-label={`Select project ${project.title}`}
      aria-current={isSelected ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(project);
        }
      }}
      onClick={() => onSelect(project)}
      className={cn(
        "relative rounded-xl backdrop-blur-md w-72 min-h-[180px] cursor-pointer overflow-visible group flex flex-col",
        "transition-all duration-300",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900",
        project.pinned
          ? "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10"
          : isSelected
            ? "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20"
            : "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30",
        "border",
        project.pinned
          ? "border-purple-500/80 dark:border-purple-500/80 shadow-[0_0_15px_rgba(168,85,247,0.3)]"
          : isSelected
            ? "border-purple-400/60 dark:border-purple-500/60"
            : "border-gray-200 dark:border-zinc-800/50",
        isSelected
          ? "shadow-[0_0_15px_rgba(168,85,247,0.4),0_0_10px_rgba(147,51,234,0.3)] dark:shadow-[0_0_20px_rgba(168,85,247,0.5),0_0_15px_rgba(147,51,234,0.4)]"
          : "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]",
        "hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.2)] dark:hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.9)]",
        isSelected ? "scale-[1.02]" : "hover:scale-[1.01]", // Use scale instead of translate to avoid clipping
        optimistic && "opacity-80 ring-1 ring-cyan-400/30",
      )}
    >
      {/* Subtle aurora glow effect for selected card */}
      {isSelected && (
        <div className="absolute inset-0 rounded-xl overflow-hidden opacity-30 dark:opacity-40 pointer-events-none">
          <div className="absolute -inset-[100px] bg-[radial-gradient(circle,rgba(168,85,247,0.8)_0%,rgba(147,51,234,0.6)_40%,transparent_70%)] blur-3xl animate-[pulse_8s_ease-in-out_infinite]"></div>
        </div>
      )}

      {/* Main content area with padding */}
      <div className="flex-1 p-4 pb-2">
        {/* Title section */}
        <div className="flex flex-col items-center justify-center mb-4 min-h-[48px]">
          <h3
            className={cn(
              "font-medium text-center leading-tight line-clamp-2 transition-all duration-300",
              isSelected
                ? "text-gray-900 dark:text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                : project.pinned
                  ? "text-purple-700 dark:text-purple-300"
                  : "text-gray-500 dark:text-gray-400",
            )}
          >
            {project.title}
          </h3>
          <OptimisticIndicator isOptimistic={optimistic} className="mt-1" />
        </div>

        {/* Task count pills */}
        <div className="flex items-stretch gap-2 w-full">
          {/* Todo pill */}
          <div className="relative flex-1">
            <div
              className={cn(
                "absolute inset-0 bg-pink-600 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            ></div>
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-pink-300 dark:border-pink-500/50 dark:shadow-[0_0_10px_rgba(236,72,153,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(236,72,153,0.7)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <ListTodo
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  ToDo
                </span>
              </div>
              <div
                className={cn(
                  "flex-1 flex items-center justify-center border-l",
                  isSelected ? "border-pink-300 dark:border-pink-500/30" : "border-gray-300/50 dark:border-gray-700/50",
                )}
              >
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {taskCounts.todo || 0}
                </span>
              </div>
            </div>
          </div>

          {/* Doing pill (includes review) */}
          <div className="relative flex-1">
            <div
              className={cn(
                "absolute inset-0 bg-blue-600 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            ></div>
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(59,130,246,0.7)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <Activity
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  Doing
                </span>
              </div>
              <div
                className={cn(
                  "flex-1 flex items-center justify-center border-l",
                  isSelected ? "border-blue-300 dark:border-blue-500/30" : "border-gray-300/50 dark:border-gray-700/50",
                )}
              >
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {(taskCounts.doing || 0) + (taskCounts.review || 0)}
                </span>
              </div>
            </div>
          </div>

          {/* Done pill */}
          <div className="relative flex-1">
            <div
              className={cn(
                "absolute inset-0 bg-green-600 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            ></div>
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-green-300 dark:border-green-500/50 dark:shadow-[0_0_10px_rgba(34,197,94,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(34,197,94,0.7)]"
                  : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
              )}
            >
              <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                <CheckCircle2
                  className={cn(
                    "w-4 h-4",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                />
                <span
                  className={cn(
                    "text-[8px] font-medium",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  Done
                </span>
              </div>
              <div
                className={cn(
                  "flex-1 flex items-center justify-center border-l",
                  isSelected
                    ? "border-green-300 dark:border-green-500/30"
                    : "border-gray-300/50 dark:border-gray-700/50",
                )}
              >
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {taskCounts.done || 0}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar with pinned indicator and actions - separate section */}
      <div className="flex items-center justify-between px-3 py-2 mt-auto border-t border-gray-200/30 dark:border-gray-700/20">
        {/* Pinned indicator badge */}
        {project.pinned ? (
          <div className="px-2 py-0.5 bg-purple-500 text-white text-[10px] font-bold rounded-full shadow-lg shadow-purple-500/30">
            DEFAULT
          </div>
        ) : (
          <div></div>
        )}

        {/* Action Buttons - fixed to bottom right */}
        <ProjectCardActions
          projectId={project.id}
          projectTitle={project.title}
          isPinned={project.pinned}
          onPin={(e) => {
            e.stopPropagation();
            onPin(e, project.id);
          }}
          onDelete={(e) => {
            e.stopPropagation();
            onDelete(e, project.id, project.title);
          }}
        />
      </div>
    </motion.div>
  );
};
