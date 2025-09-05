import { motion } from "framer-motion";
import { AlertCircle, Loader2 } from "lucide-react";
import React from "react";
import { Button } from "../../ui/primitives";
import type { Project } from "../types";
import { ProjectCard } from "./ProjectCard";

interface ProjectListProps {
  projects: Project[];
  selectedProject: Project | null;
  taskCounts: Record<string, { todo: number; doing: number; review: number; done: number }>;
  isLoading: boolean;
  error: Error | null;
  onProjectSelect: (project: Project) => void;
  onPinProject: (e: React.MouseEvent, projectId: string) => void;
  onDeleteProject: (e: React.MouseEvent, projectId: string, title: string) => void;
  onRetry: () => void;
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export const ProjectList: React.FC<ProjectListProps> = ({
  projects,
  selectedProject,
  taskCounts,
  isLoading,
  error,
  onProjectSelect,
  onPinProject,
  onDeleteProject,
  onRetry,
}) => {
  // Sort projects - pinned first, then by creation date (newest first)
  const sortedProjects = React.useMemo(() => {
    return [...projects].sort((a, b) => {
      // Pinned projects always come first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;

      // Then sort by creation date (newest first)
      // This ensures new projects appear on the left after pinned ones
      const timeA = Number.isFinite(Date.parse(a.created_at)) ? Date.parse(a.created_at) : 0;
      const timeB = Number.isFinite(Date.parse(b.created_at)) ? Date.parse(b.created_at) : 0;
      const byDate = timeB - timeA; // Newer first
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id); // Tie-break with ID for deterministic sort
    });
  }, [projects]);

  if (isLoading) {
    return (
      <motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
        <div className="flex items-center justify-center py-12">
          <div className="text-center" role="status" aria-live="polite" aria-busy="true">
            <Loader2 className="w-8 h-8 text-purple-500 mx-auto mb-4 animate-spin" />
            <p className="text-gray-600 dark:text-gray-400">Loading your projects...</p>
          </div>
        </div>
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
        <div className="flex items-center justify-center py-12">
          <div className="text-center" role="alert" aria-live="assertive">
            <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
            <p className="text-red-600 dark:text-red-400 mb-4">{error.message || "Failed to load projects"}</p>
            <Button onClick={onRetry} variant="default">
              Try Again
            </Button>
          </div>
        </div>
      </motion.div>
    );
  }

  if (sortedProjects.length === 0) {
    return (
      <motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              No projects yet. Create your first project to get started!
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial="hidden" animate="visible" className="relative mb-10" variants={itemVariants}>
      <div className="overflow-x-auto overflow-y-visible pb-4 pt-2 scrollbar-thin">
        <div className="flex gap-4 min-w-max" role="list" aria-label="Projects">
          {sortedProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              isSelected={selectedProject?.id === project.id}
              taskCounts={taskCounts[project.id] || { todo: 0, doing: 0, review: 0, done: 0 }}
              onSelect={onProjectSelect}
              onPin={onPinProject}
              onDelete={onDeleteProject}
            />
          ))}
        </div>
      </div>
    </motion.div>
  );
};
