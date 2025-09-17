import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Pin, Search, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Button, Input } from "../../ui/primitives";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import type { Project } from "../types";

interface ProjectSidebarProps {
  projects: Project[];
  selectedProject: Project | null;
  taskCounts: Record<string, { todo: number; doing: number; review: number; done: number }>;
  isLoading: boolean;
  error: Error | null;
  onProjectSelect: (project: Project) => void;
  onPinProject: (e: React.MouseEvent, projectId: string) => void;
  onDeleteProject: (e: React.MouseEvent, projectId: string, title: string) => void;
  className?: string;
  isMobileOpen?: boolean;
  onMobileClose?: () => void;
}

interface ProjectSidebarItemProps {
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
}

const ProjectSidebarItem: React.FC<ProjectSidebarItemProps> = ({
  project,
  isSelected,
  taskCounts,
  onSelect,
  onPin,
}) => {
  const activeTasks = taskCounts.todo + taskCounts.doing + taskCounts.review;

  return (
    <motion.div
      tabIndex={0}
      role="button"
      aria-label={`Select project ${project.title}`}
      aria-current={isSelected ? "page" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(project);
        }
      }}
      onClick={() => onSelect(project)}
      className={cn(
        "group relative p-3 rounded-lg cursor-pointer transition-all duration-200",
        "border backdrop-blur-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-900",
        isSelected
          ? cn(
              glassmorphism.background.subtle,
              glassmorphism.border.default,
              "shadow-lg shadow-purple-500/20",
              "bg-gradient-to-r from-purple-50/80 to-blue-50/80 dark:from-purple-900/30 dark:to-blue-900/30",
            )
          : cn(
              glassmorphism.background.card,
              glassmorphism.border.default,
              "hover:border-purple-300 dark:hover:border-purple-700",
              "hover:shadow-md",
            ),
      )}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      {/* Pin indicator */}
      {project.pinned && (
        <div className="absolute top-2 right-2">
          <Pin className="w-3 h-3 text-purple-500 fill-purple-500" />
        </div>
      )}

      {/* Project title */}
      <div className="mb-2 pr-6">
        <h3
          className={cn(
            "font-medium text-sm leading-tight line-clamp-2",
            isSelected
              ? "text-gray-900 dark:text-white"
              : "text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white",
          )}
        >
          {project.title}
        </h3>
      </div>

      {/* Task counts - compact horizontal layout */}
      <div className="flex items-center gap-1 text-xs">
        {/* Todo */}
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-full border",
            isSelected
              ? "bg-pink-100/80 border-pink-300 text-pink-700 dark:bg-pink-900/30 dark:border-pink-700 dark:text-pink-300"
              : "bg-gray-100/60 border-gray-300 text-gray-600 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-400",
          )}
        >
          <span className="font-medium">{taskCounts.todo}</span>
        </div>

        {/* Active (Doing + Review) */}
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-full border",
            isSelected
              ? "bg-blue-100/80 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-300"
              : "bg-gray-100/60 border-gray-300 text-gray-600 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-400",
          )}
        >
          <span className="font-medium">{activeTasks}</span>
        </div>

        {/* Done */}
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded-full border",
            isSelected
              ? "bg-green-100/80 border-green-300 text-green-700 dark:bg-green-900/30 dark:border-green-700 dark:text-green-300"
              : "bg-gray-100/60 border-gray-300 text-gray-600 dark:bg-gray-800/40 dark:border-gray-700 dark:text-gray-400",
          )}
        >
          <span className="font-medium">{taskCounts.done}</span>
        </div>
      </div>

      {/* Pin action button - only show on hover */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPin(e, project.id);
        }}
        className={cn(
          "absolute top-2 right-2 p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity",
          "hover:bg-purple-100 dark:hover:bg-purple-900/50",
          project.pinned && "opacity-100",
        )}
        aria-label={project.pinned ? "Unpin project" : "Pin project"}
      >
        <Pin className={cn("w-3 h-3", project.pinned ? "text-purple-500 fill-purple-500" : "text-gray-400")} />
      </button>
    </motion.div>
  );
};

export const ProjectSidebar: React.FC<ProjectSidebarProps> = ({
  projects,
  selectedProject,
  taskCounts,
  isLoading,
  error,
  onProjectSelect,
  onPinProject,
  className,
  isMobileOpen = false,
  onMobileClose,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isMobile, setIsMobile] = useState(false);

  // Check if we're on mobile
  useEffect(() => {
    const checkIsMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkIsMobile();
    window.addEventListener("resize", checkIsMobile);
    return () => window.removeEventListener("resize", checkIsMobile);
  }, []);

  // Auto-collapse on mobile
  useEffect(() => {
    if (isMobile) {
      setIsCollapsed(true);
    }
  }, [isMobile]);

  // Filter and sort projects
  const filteredProjects = projects
    .filter((project) => (searchQuery ? project.title.toLowerCase().includes(searchQuery.toLowerCase()) : true))
    .sort((a, b) => {
      // Pinned projects first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // Then by creation date (newest first)
      const timeA = Date.parse(a.created_at) || 0;
      const timeB = Date.parse(b.created_at) || 0;
      return timeB - timeA;
    });

  if (isLoading) {
    return (
      <div className={cn("w-80 border-r", glassmorphism.border.default, className)}>
        <div className="p-4">
          <div className="animate-pulse space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={`skeleton-${i}`} className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("w-80 border-r p-4", glassmorphism.border.default, className)}>
        <div className="text-red-600 dark:text-red-400 text-sm">Failed to load projects: {error.message}</div>
      </div>
    );
  }

  // Mobile overlay version
  if (isMobile) {
    return (
      <>
        {/* Mobile Overlay */}
        {isMobileOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 z-40"
              onClick={onMobileClose}
            />

            {/* Sidebar */}
            <motion.div
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
              className={cn(
                "fixed left-0 top-0 h-full w-80 z-50 flex flex-col",
                glassmorphism.background.card,
                "border-r backdrop-blur-sm",
                glassmorphism.border.default,
                className,
              )}
            >
              {/* Mobile Header with Close */}
              <div className="flex items-center justify-between p-4 border-b border-gray-200/30 dark:border-gray-700/30">
                <h2 className="font-semibold text-gray-900 dark:text-white">Projects</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onMobileClose}
                  className="p-2"
                  aria-label="Close projects sidebar"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {/* Search */}
              <div className="p-4 pb-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    placeholder="Search projects..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-9"
                  />
                </div>
              </div>

              {/* Project List */}
              <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
                {filteredProjects.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-500 dark:text-gray-400 text-sm">
                      {searchQuery ? "No projects match your search" : "No projects yet"}
                    </p>
                  </div>
                ) : (
                  filteredProjects.map((project) => (
                    <ProjectSidebarItem
                      key={project.id}
                      project={project}
                      isSelected={selectedProject?.id === project.id}
                      taskCounts={taskCounts[project.id] || { todo: 0, doing: 0, review: 0, done: 0 }}
                      onSelect={(project) => {
                        onProjectSelect(project);
                        onMobileClose?.();
                      }}
                      onPin={onPinProject}
                    />
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </>
    );
  }

  return (
    <motion.div
      className={cn(
        "border-r backdrop-blur-sm flex flex-col h-full",
        glassmorphism.border.default,
        glassmorphism.background.card,
        isCollapsed ? "w-16" : "w-80",
        className,
      )}
      animate={{ width: isCollapsed ? 64 : 320 }}
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
    >
      {/* Sidebar Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200/30 dark:border-gray-700/30">
        {!isCollapsed && <h2 className="font-semibold text-gray-900 dark:text-white">Projects</h2>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-2"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </div>

      {!isCollapsed && (
        <>
          {/* Search */}
          <div className="p-4 pb-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
          </div>

          {/* Project List */}
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
            {filteredProjects.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                  {searchQuery ? "No projects match your search" : "No projects yet"}
                </p>
              </div>
            ) : (
              filteredProjects.map((project) => (
                <ProjectSidebarItem
                  key={project.id}
                  project={project}
                  isSelected={selectedProject?.id === project.id}
                  taskCounts={taskCounts[project.id] || { todo: 0, doing: 0, review: 0, done: 0 }}
                  onSelect={onProjectSelect}
                  onPin={onPinProject}
                />
              ))
            )}
          </div>
        </>
      )}

      {/* Collapsed state - show only selected project indicator */}
      {isCollapsed && selectedProject && (
        <div className="p-2">
          <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center border border-purple-300 dark:border-purple-700">
            <span className="text-purple-700 dark:text-purple-300 font-bold text-sm">
              {selectedProject.title.charAt(0).toUpperCase()}
            </span>
          </div>
        </div>
      )}
    </motion.div>
  );
};
