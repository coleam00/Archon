import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { useStaggeredEntrance } from "../../../hooks/useStaggeredEntrance";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives";
import { NewProjectModal } from "../components/NewProjectModal";
import { ProjectHeaderWithToggle } from "../components/ProjectHeaderWithToggle";
import { ProjectList } from "../components/ProjectList";
import { DocsTab } from "../documents/DocsTab";
import {
  useDeleteProject,
  useProjects,
  useTaskCounts,
  useUpdateProject,
} from "../hooks/useProjectQueries";
import { TasksTab } from "../tasks/TasksTab";
import type { Project } from "../types";

interface ProjectsViewWithToggleProps {
  useSidebarLayout?: boolean;
  onToggleLayout?: () => void;
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

export function ProjectsViewWithToggle({
  useSidebarLayout = false,
  onToggleLayout,
  className = "",
  "data-id": dataId
}: ProjectsViewWithToggleProps) {
  const { projectId } = useParams();
  const navigate = useNavigate();

  // State management
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("tasks");
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

  // Staggered entrance animation
  const isVisible = useStaggeredEntrance([1, 2], 0.15);

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className={`min-h-screen p-6 ${className}`}
      data-id={dataId}
    >
      <div className="max-w-7xl mx-auto">
        {/* Header with Toggle */}
        <ProjectHeaderWithToggle
          onNewProject={() => setIsNewProjectModalOpen(true)}
          useSidebarLayout={useSidebarLayout}
          onToggleLayout={onToggleLayout}
        />

        {/* Project List */}
        <ProjectList
          projects={sortedProjects}
          selectedProject={selectedProject}
          taskCounts={taskCounts}
          isLoading={isLoadingProjects}
          error={projectsError as Error | null}
          onProjectSelect={handleProjectSelect}
          onPinProject={handlePinProject}
          onDeleteProject={handleDeleteProject}
          onRetry={() => window.location.reload()}
        />

        {/* Tabs for selected project */}
        {selectedProject && (
          <div className="mt-8">
            <Tabs defaultValue="tasks" value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="tasks" className="py-3 font-mono transition-all duration-300" color="orange">
                  Tasks
                  <span className="ml-2 px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 text-xs rounded-full">
                    {(taskCounts[selectedProject.id]?.todo || 0) + (taskCounts[selectedProject.id]?.doing || 0) + (taskCounts[selectedProject.id]?.review || 0)}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="docs" className="py-3 font-mono transition-all duration-300" color="blue">
                  Docs
                </TabsTrigger>
              </TabsList>
              <TabsContent value="tasks" className="mt-6">
                <TasksTab projectId={selectedProject.id} />
              </TabsContent>
              <TabsContent value="docs" className="mt-6">
                <DocsTab project={selectedProject} />
              </TabsContent>
            </Tabs>
          </div>
        )}
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