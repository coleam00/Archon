import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Activity, CheckCircle2, FileText, LayoutGrid, List, ListTodo, Pin } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useStaggeredEntrance } from "../../../hooks/useStaggeredEntrance";
import { isOptimistic } from "../../shared/utils/optimistic";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { Button, PillNavigation, SelectableCard } from "../../ui/primitives";
import { StatPill } from "../../ui/primitives/pill";
import { cn } from "../../ui/primitives/styles";
import { NewProjectModal } from "../components/NewProjectModal";
import { ProjectHeader } from "../components/ProjectHeader";
import { ProjectList } from "../components/ProjectList";
import { DocsTab } from "../documents/DocsTab";
import { projectKeys, useDeleteProject, useProjects, useUpdateProject } from "../hooks/useProjectQueries";
import { useTaskCounts } from "../tasks/hooks";
import { TasksTab } from "../tasks/TasksTab";
import type { Project } from "../types";

interface ProjectsViewProps {
  className?: string;
  "data-id"?: string;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export function ProjectsView({ className = "", "data-id": dataId }: ProjectsViewProps) {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // State management
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("tasks");
  const [layoutMode, setLayoutMode] = useState<"horizontal" | "sidebar">("horizontal");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

  // Sort and filter projects
  const sortedProjects = useMemo(() => {
    // Filter by search query
    const filtered = (projects as Project[]).filter((project) =>
      project.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Sort: pinned first, then alphabetically
    return filtered.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.title.localeCompare(b.title);
    });
  }, [projects, searchQuery]);

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

  // Auto-select project based on URL or default to leftmost
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

    // Otherwise, select the first (leftmost) project
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
        // Success toast handled by mutation
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

  // Staggered entrance animation
  const isVisible = useStaggeredEntrance([1, 2, 3], 0.15);

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className={cn("max-w-full mx-auto", className)}
      data-id={dataId}
    >
      <ProjectHeader
        onNewProject={() => setIsNewProjectModalOpen(true)}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {layoutMode === "horizontal" ? (
        <>
          <ProjectList
            projects={sortedProjects}
            selectedProject={selectedProject}
            taskCounts={taskCounts}
            isLoading={isLoadingProjects}
            error={projectsError as Error | null}
            onProjectSelect={handleProjectSelect}
            onPinProject={handlePinProject}
            onDeleteProject={handleDeleteProject}
            onRetry={() => queryClient.invalidateQueries({ queryKey: projectKeys.lists() })}
          />

          {/* Project Details Section */}
          {selectedProject && (
            <motion.div variants={itemVariants} className="relative">
              {/* PillNavigation centered, View Toggle on right */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex-1" />
                <PillNavigation
                  items={[
                    { id: "docs", label: "Docs", icon: <FileText className="w-4 h-4" /> },
                    { id: "tasks", label: "Tasks", icon: <ListTodo className="w-4 h-4" /> },
                  ]}
                  activeSection={activeTab}
                  onSectionClick={(id) => setActiveTab(id as string)}
                  colorVariant="orange"
                  size="small"
                  showIcons={true}
                  showText={true}
                  hasSubmenus={false}
                />
                <div className="flex-1" />
              </div>

              {/* Tab content */}
              <div>
                {activeTab === "docs" && <DocsTab project={selectedProject} />}
                {activeTab === "tasks" && <TasksTab projectId={selectedProject.id} />}
              </div>
            </motion.div>
          )}
        </>
      ) : (
        /* Sidebar Mode */
        <div className="flex gap-6">
          {/* Left Sidebar - Collapsible Project List */}
          {sidebarExpanded && (
            <div className="w-64 flex-shrink-0 space-y-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white">Projects</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarExpanded(false)}
                  className="px-2"
                  aria-label="Collapse sidebar"
                  aria-expanded={sidebarExpanded}
                >
                  <List className="w-3 h-3" aria-hidden="true" />
                </Button>
              </div>
              <div className="space-y-2">
                {sortedProjects.map((project) => (
                  <SidebarProjectCard
                    key={project.id}
                    project={project}
                    isSelected={selectedProject?.id === project.id}
                    taskCounts={taskCounts[project.id] || { todo: 0, doing: 0, review: 0, done: 0 }}
                    onSelect={() => handleProjectSelect(project)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Main Content Area - CRITICAL: min-w-0 prevents page expansion */}
          <div className="flex-1 min-w-0">
            {selectedProject && (
              <>
                {/* Header with project name, tabs, view toggle inline */}
                <div className="flex items-center gap-4 mb-4">
                  {!sidebarExpanded && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSidebarExpanded(true)}
                      className="px-2 flex-shrink-0"
                      aria-label="Expand sidebar"
                      aria-expanded={sidebarExpanded}
                    >
                      <List className="w-3 h-3 mr-1" aria-hidden="true" />
                      <span className="text-sm font-medium">{selectedProject.title}</span>
                    </Button>
                  )}

                  {/* PillNavigation - ALWAYS CENTERED */}
                  <div className="flex-1 flex justify-center">
                    <PillNavigation
                      items={[
                        { id: "docs", label: "Docs", icon: <FileText className="w-4 h-4" /> },
                        { id: "tasks", label: "Tasks", icon: <ListTodo className="w-4 h-4" /> },
                      ]}
                      activeSection={activeTab}
                      onSectionClick={(id) => setActiveTab(id as string)}
                      colorVariant="orange"
                      size="small"
                      showIcons={true}
                      showText={true}
                      hasSubmenus={false}
                    />
                  </div>
                  <div className="flex-1" />
                </div>

                {/* Tab Content */}
                <div>
                  {activeTab === "docs" && <DocsTab project={selectedProject} />}
                  {activeTab === "tasks" && <TasksTab projectId={selectedProject.id} />}
                </div>
              </>
            )}
          </div>
        </div>
      )}

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

// Sidebar Project Card - compact variant with StatPills
interface SidebarProjectCardProps {
  project: Project;
  isSelected: boolean;
  taskCounts: {
    todo: number;
    doing: number;
    review: number;
    done: number;
  };
  onSelect: () => void;
}

const SidebarProjectCard: React.FC<SidebarProjectCardProps> = ({ project, isSelected, taskCounts, onSelect }) => {
  const optimistic = isOptimistic(project);

  const getBackgroundClass = () => {
    if (project.pinned)
      return "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10";
    if (isSelected)
      return "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20";
    return "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30";
  };

  return (
    <SelectableCard
      isSelected={isSelected}
      isPinned={project.pinned}
      showAuroraGlow={isSelected}
      onSelect={onSelect}
      size="none"
      blur="md"
      className={cn("p-2", getBackgroundClass(), optimistic && "opacity-80 ring-1 ring-cyan-400/30")}
    >
      <div className="space-y-2">
        {/* Title */}
        <div className="flex items-center justify-between">
          <h4
            className={cn(
              "font-medium text-sm line-clamp-1 flex-1",
              isSelected ? "text-purple-700 dark:text-purple-300" : "text-gray-700 dark:text-gray-300",
            )}
          >
            {project.title}
          </h4>
          <div className="flex items-center gap-1">
            {project.pinned && (
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-500 dark:bg-purple-600 text-white text-[9px] font-bold rounded-full"
                aria-label="Pinned"
              >
                <Pin className="w-2.5 h-2.5" aria-hidden="true" />
              </div>
            )}
            <OptimisticIndicator isOptimistic={optimistic} />
          </div>
        </div>

        {/* Status Pills - horizontal layout with icons */}
        <div className="flex items-center gap-1.5">
          <StatPill color="pink" value={taskCounts.todo} size="sm" icon={<ListTodo className="w-3 h-3" />} />
          <StatPill
            color="blue"
            value={taskCounts.doing + taskCounts.review}
            size="sm"
            icon={<Activity className="w-3 h-3" />}
          />
          <StatPill color="green" value={taskCounts.done} size="sm" icon={<CheckCircle2 className="w-3 h-3" />} />
        </div>
      </div>
    </SelectableCard>
  );
};
