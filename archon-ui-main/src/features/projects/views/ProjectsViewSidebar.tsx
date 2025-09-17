import { motion } from "framer-motion";
import { Layout, Menu, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Toggle } from "../../../components/ui/Toggle";
import { useStaggeredEntrance } from "../../../hooks/useStaggeredEntrance";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Button } from "../../ui/primitives";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import { NewProjectModal } from "../components/NewProjectModal";
import { ProjectMainContent } from "../components/ProjectMainContent";
import { ProjectSidebar } from "../components/ProjectSidebar";
import { useDeleteProject, useProjects, useTaskCounts, useUpdateProject } from "../hooks/useProjectQueries";
import type { Project } from "../types";

interface ProjectsViewSidebarProps {
  className?: string;
  "data-id"?: string;
  useSidebarLayout?: boolean;
  onToggleLayout?: () => void;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

export function ProjectsViewSidebar({
  className = "",
  "data-id": dataId,
  useSidebarLayout = true,
  onToggleLayout
}: ProjectsViewSidebarProps) {
  const { projectId } = useParams();
  const navigate = useNavigate();

  // State management
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("tasks");
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // React Query hooks
  const { data: projects = [], isLoading: isLoadingProjects, error: projectsError } = useProjects();
  const { data: taskCounts = {}, refetch: refetchTaskCounts } = useTaskCounts();

  // Mutations
  const updateProjectMutation = useUpdateProject();
  const deleteProjectMutation = useDeleteProject();

  // Sort projects - pinned first, then alphabetically
  const sortedProjects = useMemo(() => {
    return [...(projects as Project[])].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.title.localeCompare(b.title);
    });
  }, [projects]);

  // Handle project selection
  const handleProjectSelect = useCallback(
    (project: Project) => {
      if (selectedProject?.id === project.id) return;

      setSelectedProject(project);
      setActiveTab("tasks");
      navigate(`/projects/${project.id}`, { replace: true });
    },
    [selectedProject?.id, navigate],
  );

  // Auto-select project based on URL or default to first
  useEffect(() => {
    if (!sortedProjects.length) return;

    // If there's a projectId in the URL, select that project
    if (projectId) {
      const project = sortedProjects.find((p) => p.id === projectId);
      if (project) {
        setSelectedProject(project);
        return;
      }
    }

    // Otherwise, select the first project
    if (!selectedProject || !sortedProjects.find((p) => p.id === selectedProject.id)) {
      const defaultProject = sortedProjects[0];
      setSelectedProject(defaultProject);
      navigate(`/projects/${defaultProject.id}`, { replace: true });
    }
  }, [sortedProjects, projectId, selectedProject, navigate]);

  // Refetch task counts when projects change
  useEffect(() => {
    if ((projects as Project[]).length > 0) {
      refetchTaskCounts();
    }
  }, [projects, refetchTaskCounts]);

  // Handle pin toggle
  const handlePinProject = async (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    const project = (projects as Project[]).find((p) => p.id === projectId);
    if (!project) return;

    updateProjectMutation.mutate({
      projectId,
      updates: { pinned: !project.pinned },
    });
  };

  // Handle delete project
  const handleDeleteProject = (e: React.MouseEvent, projectId: string, title: string) => {
    e.stopPropagation();
    setProjectToDelete({ id: projectId, title });
    setShowDeleteConfirm(true);
  };

  const confirmDeleteProject = () => {
    if (!projectToDelete) return;

    deleteProjectMutation.mutate(projectToDelete.id, {
      onSuccess: () => {
        setShowDeleteConfirm(false);
        setProjectToDelete(null);

        // If we deleted the selected project, select another one
        if (selectedProject?.id === projectToDelete.id) {
          const remainingProjects = (projects as Project[]).filter((p) => p.id !== projectToDelete.id);
          if (remainingProjects.length > 0) {
            const nextProject = remainingProjects[0];
            setSelectedProject(nextProject);
            navigate(`/projects/${nextProject.id}`, { replace: true });
          } else {
            setSelectedProject(null);
            navigate("/projects", { replace: true });
          }
        }
      },
    });
  };

  const cancelDeleteProject = () => {
    setShowDeleteConfirm(false);
    setProjectToDelete(null);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if we're not in an input or modal
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Cmd/Ctrl + K to open mobile sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsMobileSidebarOpen(true);
        return;
      }

      // Escape to close mobile sidebar
      if (e.key === "Escape" && isMobileSidebarOpen) {
        e.preventDefault();
        setIsMobileSidebarOpen(false);
        return;
      }

      // Arrow keys to navigate between projects
      if (!sortedProjects.length || !selectedProject) return;

      const currentIndex = sortedProjects.findIndex((p) => p.id === selectedProject.id);
      if (currentIndex === -1) return;

      let newIndex = currentIndex;

      if (e.key === "ArrowUp" && currentIndex > 0) {
        e.preventDefault();
        newIndex = currentIndex - 1;
      } else if (e.key === "ArrowDown" && currentIndex < sortedProjects.length - 1) {
        e.preventDefault();
        newIndex = currentIndex + 1;
      }

      if (newIndex !== currentIndex) {
        handleProjectSelect(sortedProjects[newIndex]);
      }

      // Tab switching
      if ((e.metaKey || e.ctrlKey) && e.key === "1") {
        e.preventDefault();
        setActiveTab("tasks");
      } else if ((e.metaKey || e.ctrlKey) && e.key === "2") {
        e.preventDefault();
        setActiveTab("docs");
      }

      // New project shortcut
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        setIsNewProjectModalOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sortedProjects, selectedProject, handleProjectSelect, isMobileSidebarOpen]);

  // Staggered entrance animation
  const isVisible = useStaggeredEntrance([1, 2], 0.15);

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className={cn("flex flex-col h-screen max-h-screen overflow-hidden", className)}
      data-id={dataId}
    >
      {/* Top Header */}
      <div className={cn("flex items-center justify-between p-4 border-b", glassmorphism.border.default)}>
        <div className="flex items-center gap-3">
          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsMobileSidebarOpen(true)}
            className="p-2 md:hidden"
            aria-label="Open projects sidebar"
          >
            <Menu className="w-4 h-4" />
          </Button>

          <img
            src="/logo-neon.png"
            alt="Projects"
            className="w-7 h-7 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]"
          />
          <h1 className="text-xl font-bold text-gray-800 dark:text-white">Projects</h1>

          {/* Current project indicator on mobile */}
          {selectedProject && (
            <div className="md:hidden px-2 py-1 bg-purple-100 dark:bg-purple-900/30 rounded text-sm font-medium text-purple-700 dark:text-purple-300 truncate max-w-32">
              {selectedProject.title}
            </div>
          )}

          {/* Keyboard shortcuts hint */}
          <div className="hidden lg:flex text-xs text-gray-500 dark:text-gray-400 space-x-4">
            <span>⌘K Search</span>
            <span>↑↓ Navigate</span>
            <span>⌘N New</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Layout Toggle */}
          {onToggleLayout && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600 dark:text-gray-400 hidden md:inline">
                Sidebar Layout
              </span>
              <Toggle
                checked={useSidebarLayout}
                onCheckedChange={onToggleLayout}
                accentColor="purple"
                icon={<Layout className="w-4 h-4" />}
              />
            </div>
          )}

          {/* New Project Button */}
          <Button onClick={() => setIsNewProjectModalOpen(true)} variant="cyan" className="shadow-lg shadow-cyan-500/20">
            <Plus className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">New Project</span>
          </Button>
        </div>
      </div>

      {/* Main Layout: Sidebar + Content */}
      <div className="flex flex-1 min-h-0">
        {/* Desktop Sidebar */}
        <div className="hidden md:flex">
          <ProjectSidebar
            projects={sortedProjects}
            selectedProject={selectedProject}
            taskCounts={taskCounts}
            isLoading={isLoadingProjects}
            error={projectsError as Error | null}
            onProjectSelect={handleProjectSelect}
            onPinProject={handlePinProject}
            onDeleteProject={handleDeleteProject}
          />
        </div>

        {/* Mobile Sidebar Overlay - only render when needed */}
        {isMobileSidebarOpen && (
          <ProjectSidebar
            projects={sortedProjects}
            selectedProject={selectedProject}
            taskCounts={taskCounts}
            isLoading={isLoadingProjects}
            error={projectsError as Error | null}
            onProjectSelect={handleProjectSelect}
            onPinProject={handlePinProject}
            onDeleteProject={handleDeleteProject}
            isMobileOpen={isMobileSidebarOpen}
            onMobileClose={() => setIsMobileSidebarOpen(false)}
          />
        )}

        {/* Main Content */}
        <ProjectMainContent
          selectedProject={selectedProject}
          taskCounts={taskCounts}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className={cn("flex-1", glassmorphism.background.subtle)}
        />
      </div>

      {/* Modals */}
      <NewProjectModal
        open={isNewProjectModalOpen}
        onOpenChange={setIsNewProjectModalOpen}
        onSuccess={() => refetchTaskCounts()}
      />

      {showDeleteConfirm && projectToDelete && (
        <DeleteConfirmModal
          itemName={projectToDelete.title}
          onConfirm={confirmDeleteProject}
          onCancel={cancelDeleteProject}
          type="project"
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
        />
      )}
    </motion.div>
  );
}
