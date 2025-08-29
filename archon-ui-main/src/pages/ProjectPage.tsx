import { useState, useEffect, useCallback } from "react";
import { useToast } from "../contexts/ToastContext";
import { motion, AnimatePresence } from "framer-motion";
import { useStaggeredEntrance } from "../hooks/useStaggeredEntrance";
import { useProjectPolling, useTaskPolling } from "../hooks/usePolling";
import { useDatabaseMutation } from "../hooks/useDatabaseMutation";
import { useProjectMutation } from "../hooks/useProjectMutation";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/project-tasks/Tabs";
import { DocsTab } from "../components/project-tasks/DocsTab";
// import { FeaturesTab } from '../components/project-tasks/FeaturesTab';
// import { DataTab } from '../components/project-tasks/DataTab';
import { TasksTab } from "../components/project-tasks/TasksTab";
import { Button } from "../components/ui/Button";
import {
  ChevronRight,
  ShoppingCart,
  Code,
  Briefcase,
  Layers,
  Plus,
  X,
  AlertCircle,
  Loader2,
  Heart,
  BarChart3,
  Trash2,
  Pin,
  ListTodo,
  Activity,
  CheckCircle2,
  Clipboard,
} from "lucide-react";

// Import our service layer and types
import { projectService } from "../services/projectService";
import type { Project, CreateProjectRequest } from "../types/project";
import type { Task } from "../components/project-tasks/TaskTableView";

// Reusable Delete Confirmation Modal Component
interface DeleteConfirmModalProps {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type: "project" | "task" | "client";
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  itemName,
  onConfirm,
  onCancel,
  type,
}) => {
  const getTitle = () => {
    switch (type) {
      case "project":
        return "Delete Project";
      case "task":
        return "Delete Task";
      case "client":
        return "Delete MCP Client";
    }
  };

  const getMessage = () => {
    switch (type) {
      case "project":
        return `Are you sure you want to delete the "${itemName}" project? This will also delete all associated tasks and documents and cannot be undone.`;
      case "task":
        return `Are you sure you want to delete the "${itemName}" task? This action cannot be undone.`;
      case "client":
        return `Are you sure you want to delete the "${itemName}" client? This will permanently remove its configuration and cannot be undone.`;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-red-500 
          before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]"
      >
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-white">
                {getTitle()}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>

          <p className="text-gray-700 dark:text-gray-300 mb-6">
            {getMessage()}
          </p>

          <div className="flex justify-end gap-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors shadow-lg shadow-red-600/25 hover:shadow-red-700/25"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ProjectPageProps {
  className?: string;
  "data-id"?: string;
}

// Icon mapping for projects (since database stores icon names as strings)
const getProjectIcon = (iconName?: string) => {
  const iconMap = {
    ShoppingCart: <ShoppingCart className="w-5 h-5" />,
    Briefcase: <Briefcase className="w-5 h-5" />,
    Code: <Code className="w-5 h-5" />,
    Layers: <Layers className="w-5 h-5" />,
    BarChart: <BarChart3 className="w-5 h-5" />,
    Heart: <Heart className="w-5 h-5" />,
  };
  return (
    iconMap[iconName as keyof typeof iconMap] || (
      <Briefcase className="w-5 h-5" />
    )
  );
};

function ProjectPage({
  className = "",
  "data-id": dataId,
}: ProjectPageProps) {
  // State management for real data
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectTaskCounts, setProjectTaskCounts] = useState<
    Record<string, { todo: number; doing: number; done: number }>
  >({});
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [isSwitchingProject, setIsSwitchingProject] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState("tasks");
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);

  // New project form state
  const [newProjectForm, setNewProjectForm] = useState({
    title: "",
    description: "",
    color: "blue" as const,
  });

  // Handler for retrying project creation

  // State for delete confirmation modal
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const { showToast } = useToast();

  // Polling hooks for real-time updates
  const {
    data: projectsData,
    isLoading: isLoadingProjects,
    error: projectsError,
    refetch: refetchProjects,
  } = useProjectPolling({
    onError: (error) => {
      console.error("Failed to load projects:", error);
      showToast("Failed to load projects. Please try again.", "error");
    },
  });

  // Derive projects array from polling data - ensure it's always an array
  const projects = projectsData?.projects || [];

  // Poll tasks for selected project
  const {
    data: tasksData,
    isLoading: isPollingTasks,
    error: tasksPollingError,
    refetch: refetchTasks,
  } = useTaskPolling(selectedProject?.id || "", {
    enabled: !!selectedProject,
    onError: (error) => {
      console.error("Failed to load tasks:", error);
      setTasksError(error.message);
    },
    // Removed onSuccess callback - direct API calls handle task updates
    // Polling now only used for ETag efficiency, not state updates
  });


  // Project mutations
  const deleteProjectMutation = useProjectMutation(
    null,
    async (projectId: string) => {
      return await projectService.deleteProject(projectId);
    },
    {
      successMessage: projectToDelete 
        ? `Project "${projectToDelete.title}" deleted successfully`
        : "Project deleted successfully",
      onSuccess: () => {
        if (selectedProject?.id === projectToDelete?.id) {
          setSelectedProject(null);
          setShowProjectDetails(false);
        }
        setShowDeleteConfirm(false);
        setProjectToDelete(null);
      },
      onError: (error) => {
        console.error("Failed to delete project:", error);
      },
    },
  );

  const togglePinMutation = useProjectMutation(
    null,
    async ({ projectId, pinned }: { projectId: string; pinned: boolean }) => {
      return await projectService.updateProject(projectId, { pinned });
    },
    {
      onSuccess: (data, variables) => {
        const message = variables.pinned
          ? `Pinned "${data.title}" to top`
          : `Removed "${data.title}" from pinned projects`;
        showToast(message, "info");
      },
      onError: (error) => {
        console.error("Failed to update project pin status:", error);
      },
    },
  );

  const createProjectMutation = useDatabaseMutation(
    async (projectData: CreateProjectRequest) => {
      return await projectService.createProject(projectData);
    },
    {
      successMessage: "Creating project...",
      onSuccess: (response) => {
        setNewProjectForm({ title: "", description: "", color: "blue" });
        setIsNewProjectModalOpen(false);
        // Polling will pick up the new project
        showToast("Project created successfully!", "success");
        refetchProjects();
      },
      onError: (error) => {
        console.error("Failed to create project:", error);
      },
    },
  );

  const handleProjectSelect = async (project: Project) => {
    // Show loading state during project switch
    setIsSwitchingProject(true);
    setTasksError(null);
    setTasks([]); // Clear stale tasks immediately to prevent wrong data showing
    
    try {
      setSelectedProject(project);
      setShowProjectDetails(true);
      setActiveTab("tasks");
      
      // Load tasks for the new project
      await loadTasksForProject(project.id);
    } catch (error) {
      console.error('Failed to switch project:', error);
      showToast('Failed to load project tasks', 'error');
    } finally {
      setIsSwitchingProject(false);
    }
  };

  // Auto-select pinned project or first project when projects load
  useEffect(() => {
    if (!projects?.length) return;

    // console.log("📦 Projects loaded via polling:", projects.length);

    // Sort projects - pinned first, then alphabetically
    const sortedProjects = [...projects].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return a.title.localeCompare(b.title);
    });

    // Load task counts for all projects
    const projectIds = sortedProjects.map((p) => p.id);
    loadTaskCountsForAllProjects(projectIds);

    // Find pinned project - this is ALWAYS the default on page load
    const pinnedProject = sortedProjects.find((p) => p.pinned === true);
    // console.log(
    //   `📌 Pinned project:`,
    //   pinnedProject ? `${pinnedProject.title}` : "None found",
    // );

    // On page load, ALWAYS select pinned project if it exists
    if (
      pinnedProject &&
      (!selectedProject || selectedProject.id !== pinnedProject.id)
    ) {
      console.log(`✅ Selecting pinned project: ${pinnedProject.title}`);
      handleProjectSelect(pinnedProject);
    } else if (!selectedProject && sortedProjects.length > 0) {
      // No pinned project, select first one
      const firstProject = sortedProjects[0];
      console.log(
        `📋 No pinned project, selecting first: ${firstProject.title}`,
      );
      handleProjectSelect(firstProject);
    }
  }, [projects, selectedProject, handleProjectSelect]);

  // Update loading state based on polling
  useEffect(() => {
    setIsLoadingTasks(isPollingTasks);
  }, [isPollingTasks]);

  // Refresh task counts when tasks update via polling AND keep UI in sync for selected project
  useEffect(() => {
    if (tasksData?.tasks) {
      // Update tasks for the selected project to keep UI in sync with server changes
      if (selectedProject) {
        const uiTasks: Task[] = tasksData.tasks.map((task: any) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          status: (task.status || "todo") as Task["status"],
          assignee: {
            name: (task.assignee || "User") as "User" | "Archon" | "AI IDE Agent",
            avatar: "",
          },
          feature: task.feature || "General",
          featureColor: task.featureColor || "#6366f1",
          task_order: task.task_order || 0,
        }));
        setTasks(uiTasks);
      }
      
      const projectIds = projects
        .map((p) => p.id)
        .filter((id) => !id.startsWith("temp-"));
      loadTaskCountsForAllProjects(projectIds);
    }
  }, [tasksData?.tasks, projects, selectedProject]);

  // Load task counts for all projects in parallel
  const loadTaskCountsForAllProjects = useCallback(
    async (projectIds: string[]) => {
      try {
        // Fetch all project tasks in parallel
        const results = await Promise.allSettled(
          projectIds.map(async (projectId) => {
            const tasksData = await projectService.getTasksByProject(projectId);
            const todos = tasksData.filter((t: any) => t.status === "todo").length;
            const doing = tasksData.filter(
              (t: any) => t.status === "doing" || t.status === "review"
            ).length;
            const done = tasksData.filter((t: any) => t.status === "done").length;
            return { projectId, counts: { todo: todos, doing, done } };
          })
        );

        // Process results and handle failures
        const counts: Record<string, { todo: number; doing: number; done: number }> = {};
        results.forEach((result) => {
          if (result.status === "fulfilled") {
            counts[result.value.projectId] = result.value.counts;
          } else {
            // Extract projectId from the original array since we can't get it from rejection
            const failedIndex = results.indexOf(result);
            const projectId = projectIds[failedIndex];
            console.error(`Failed to load tasks for project ${projectId}:`, result.reason);
            counts[projectId] = { todo: 0, doing: 0, done: 0 };
          }
        });

        setProjectTaskCounts(counts);
      } catch (error) {
        console.error("Failed to load task counts:", error);
      }
    },
    [],
  );

  // Manual refresh function using polling refetch
  const loadProjects = async () => {
    try {
      console.log(`[LOAD PROJECTS] Manually refreshing projects...`);
      await refetchProjects();
    } catch (error) {
      console.error("Failed to refresh projects:", error);
      showToast("Failed to refresh projects. Please try again.", "error");
    }
  };

  // Direct API call for immediate task loading during project switch
  const loadTasksForProject = async (projectId: string) => {
    try {
      console.log(`[LOAD TASKS] Direct API call for project: ${projectId}`);
      const taskData = await projectService.getTasksByProject(projectId);
      
      // Use the same formatting logic as polling onSuccess callback
      const uiTasks: Task[] = taskData.map((task: any) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: (task.status || "todo") as Task["status"],
        assignee: {
          name: (task.assignee || "User") as
            | "User"
            | "Archon"
            | "AI IDE Agent",
          avatar: "",
        },
        feature: task.feature || "General",
        featureColor: task.featureColor || "#6366f1",
        task_order: task.task_order || 0,
      }));
      
      setTasks(uiTasks);
      console.log(`[LOAD TASKS] Set ${uiTasks.length} tasks immediately`);
    } catch (error) {
      console.error("Failed to load tasks:", error);
      setTasksError(
        error instanceof Error ? error.message : "Failed to load tasks",
      );
    }
  };

  const handleDeleteProject = useCallback(
    async (e: React.MouseEvent, projectId: string, projectTitle: string) => {
      e.stopPropagation();
      setProjectToDelete({ id: projectId, title: projectTitle });
      setShowDeleteConfirm(true);
    },
    [setProjectToDelete, setShowDeleteConfirm],
  );

  const confirmDeleteProject = useCallback(async () => {
    if (!projectToDelete) return;

    try {
      await deleteProjectMutation.mutateAsync(projectToDelete.id);
    } catch (error) {
      // Error handling is done by the mutation
    }
  }, [projectToDelete, deleteProjectMutation]);

  const cancelDeleteProject = useCallback(() => {
    setShowDeleteConfirm(false);
    setProjectToDelete(null);
  }, [setShowDeleteConfirm, setProjectToDelete]);

  const handleTogglePin = useCallback(
    async (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      try {
        await togglePinMutation.mutateAsync({
          projectId: project.id,
          pinned: !project.pinned,
        });
      } catch (error) {
        console.error("Failed to toggle pin:", error);
        showToast("Failed to update pin status", "error");
      }
    },
    [togglePinMutation, showToast],
  );

  const handleCreateProject = async () => {
    if (!newProjectForm.title.trim()) {
      return;
    }

    const projectData: CreateProjectRequest = {
      title: newProjectForm.title,
      description: newProjectForm.description,
      docs: [],
      features: [],
      data: [],
    };

    await createProjectMutation.mutateAsync(projectData);
  };

  // Add staggered entrance animations
  const { isVisible, containerVariants, itemVariants, titleVariants } =
    useStaggeredEntrance([1, 2, 3], 0.15);

  // Add animation for tab content
  const tabContentVariants = {
    hidden: {
      opacity: 0,
      y: 20,
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.4,
        ease: "easeOut",
      },
    },
    exit: {
      opacity: 0,
      y: -20,
      transition: {
        duration: 0.2,
      },
    },
  };

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className={`max-w-full mx-auto ${className}`}
      data-id={dataId}
    >
      {/* Page Header with New Project Button */}
      <motion.div
        className="flex items-center justify-between mb-8"
        variants={itemVariants}
      >
        <motion.h1
          className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3"
          variants={titleVariants}
        >
          <img
            src="/logo-neon.png"
            alt="Projects"
            className="w-7 h-7 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]"
          />
          Projects
        </motion.h1>
        <Button
          onClick={() => setIsNewProjectModalOpen(true)}
          variant="primary"
          accentColor="purple"
          className="shadow-lg shadow-purple-500/20"
        >
          <Plus className="w-4 h-4 mr-2 inline" />
          <span>New Project</span>
        </Button>
      </motion.div>

      {/* Projects Loading/Error States */}
      {isLoadingProjects && (
        <motion.div variants={itemVariants} className="mb-10">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="w-8 h-8 text-purple-500 mx-auto mb-4 animate-spin" />
              <p className="text-gray-600 dark:text-gray-400">
                Loading your projects...
              </p>
            </div>
          </div>
        </motion.div>
      )}

      {projectsError && (
        <motion.div variants={itemVariants} className="mb-10">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
              <p className="text-red-600 dark:text-red-400 mb-4">
                {projectsError.message || "Failed to load projects"}
              </p>
              <Button
                onClick={loadProjects}
                variant="primary"
                accentColor="purple"
              >
                Try Again
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Project Cards - Horizontally Scrollable */}
      {!isLoadingProjects && !projectsError && (
        <motion.div className="relative mb-10" variants={itemVariants}>
          <div className="overflow-x-auto pb-4 scrollbar-thin">
            <div className="flex gap-4 min-w-max">
              {projects.map((project) => (
                <motion.div
                    key={project.id}
                    variants={itemVariants}
                    onClick={() => handleProjectSelect(project)}
                    className={`
                    relative p-4 rounded-xl backdrop-blur-md w-72 cursor-pointer overflow-hidden
                    ${
                      project.pinned
                        ? "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10"
                        : selectedProject?.id === project.id
                          ? "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20"
                          : "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30"
                    }
                    border ${
                      project.pinned
                        ? "border-purple-500/80 dark:border-purple-500/80 shadow-[0_0_15px_rgba(168,85,247,0.3)]"
                        : selectedProject?.id === project.id
                          ? "border-purple-400/60 dark:border-purple-500/60"
                          : "border-gray-200 dark:border-zinc-800/50"
                    }
                    ${
                      selectedProject?.id === project.id
                        ? "shadow-[0_0_15px_rgba(168,85,247,0.4),0_0_10px_rgba(147,51,234,0.3)] dark:shadow-[0_0_20px_rgba(168,85,247,0.5),0_0_15px_rgba(147,51,234,0.4)]"
                        : "shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]"
                    }
                    hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.2)] dark:hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.9)]
                    transition-all duration-300
                    ${selectedProject?.id === project.id ? "translate-y-[-2px]" : "hover:translate-y-[-2px]"}
                  `}
                  >
                    {/* Subtle aurora glow effect for selected card */}
                    {selectedProject?.id === project.id && (
                      <div className="absolute inset-0 rounded-xl overflow-hidden opacity-30 dark:opacity-40">
                        <div className="absolute -inset-[100px] bg-[radial-gradient(circle,rgba(168,85,247,0.8)_0%,rgba(147,51,234,0.6)_40%,transparent_70%)] blur-3xl animate-[pulse_8s_ease-in-out_infinite]"></div>
                      </div>
                    )}

                    <div className="relative z-10">
                      <div className="flex items-center justify-center mb-4 px-2">
                        <h3
                          className={`font-medium text-center leading-tight line-clamp-2 transition-all duration-300 ${
                            selectedProject?.id === project.id
                              ? "text-gray-900 dark:text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
                              : "text-gray-500 dark:text-gray-400"
                          }`}
                        >
                          {project.title}
                        </h3>
                      </div>
                      <div className="flex items-stretch gap-2 w-full">
                        {/* Neon pill boxes for task counts */}
                        {/* Todo pill */}
                        <div className="relative flex-1">
                          <div
                            className={`absolute inset-0 bg-pink-600 rounded-full blur-md ${selectedProject?.id === project.id ? "opacity-30 dark:opacity-75" : "opacity-0"}`}
                          ></div>
                          <div
                            className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                              selectedProject?.id === project.id
                                ? "bg-white/70 dark:bg-zinc-900/90 border-pink-300 dark:border-pink-500/50 dark:shadow-[0_0_10px_rgba(236,72,153,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(236,72,153,0.7)]"
                                : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50"
                            }`}
                          >
                            <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                              <ListTodo
                                className={`w-4 h-4 ${selectedProject?.id === project.id ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600"}`}
                              />
                              <span
                                className={`text-[8px] font-medium ${selectedProject?.id === project.id ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                ToDo
                              </span>
                            </div>
                            <div
                              className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? "border-pink-300 dark:border-pink-500/30" : "border-gray-300/50 dark:border-gray-700/50"}`}
                            >
                              <span
                                className={`text-lg font-bold ${selectedProject?.id === project.id ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                {projectTaskCounts[project.id]?.todo || 0}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Doing pill */}
                        <div className="relative flex-1">
                          <div
                            className={`absolute inset-0 bg-blue-600 rounded-full blur-md ${selectedProject?.id === project.id ? "opacity-30 dark:opacity-75" : "opacity-0"}`}
                          ></div>
                          <div
                            className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                              selectedProject?.id === project.id
                                ? "bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(59,130,246,0.7)]"
                                : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50"
                            }`}
                          >
                            <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                              <Activity
                                className={`w-4 h-4 ${selectedProject?.id === project.id ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600"}`}
                              />
                              <span
                                className={`text-[8px] font-medium ${selectedProject?.id === project.id ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                Doing
                              </span>
                            </div>
                            <div
                              className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? "border-blue-300 dark:border-blue-500/30" : "border-gray-300/50 dark:border-gray-700/50"}`}
                            >
                              <span
                                className={`text-lg font-bold ${selectedProject?.id === project.id ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                {projectTaskCounts[project.id]?.doing || 0}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Done pill */}
                        <div className="relative flex-1">
                          <div
                            className={`absolute inset-0 bg-green-600 rounded-full blur-md ${selectedProject?.id === project.id ? "opacity-30 dark:opacity-75" : "opacity-0"}`}
                          ></div>
                          <div
                            className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                              selectedProject?.id === project.id
                                ? "bg-white/70 dark:bg-zinc-900/90 border-green-300 dark:border-green-500/50 dark:shadow-[0_0_10px_rgba(34,197,94,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(34,197,94,0.7)]"
                                : "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50"
                            }`}
                          >
                            <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                              <CheckCircle2
                                className={`w-4 h-4 ${selectedProject?.id === project.id ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600"}`}
                              />
                              <span
                                className={`text-[8px] font-medium ${selectedProject?.id === project.id ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                Done
                              </span>
                            </div>
                            <div
                              className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? "border-green-300 dark:border-green-500/30" : "border-gray-300/50 dark:border-gray-700/50"}`}
                            >
                              <span
                                className={`text-lg font-bold ${selectedProject?.id === project.id ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600"}`}
                              >
                                {projectTaskCounts[project.id]?.done || 0}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons - At bottom of card */}
                      <div className="mt-3 pt-3 border-t border-gray-200/50 dark:border-gray-700/30 flex items-center justify-between gap-2">
                        {/* Pin button */}
                        <button
                          onClick={(e) => handleTogglePin(e, project)}
                          className={`p-1.5 rounded-full ${project.pinned === true ? "bg-purple-100 text-purple-700 dark:bg-purple-700/30 dark:text-purple-400" : "bg-gray-100 text-gray-500 dark:bg-gray-800/70 dark:text-gray-400"} hover:bg-purple-200 hover:text-purple-800 dark:hover:bg-purple-800/50 dark:hover:text-purple-300 transition-colors`}
                          title={
                            project.pinned === true
                              ? "Unpin project"
                              : "Pin project"
                          }
                          aria-label={
                            project.pinned === true
                              ? "Unpin project"
                              : "Pin project"
                          }
                          data-pinned={project.pinned}
                        >
                          <Pin
                            className="w-3.5 h-3.5"
                            fill={
                              project.pinned === true ? "currentColor" : "none"
                            }
                          />
                        </button>

                        {/* Copy Project ID Button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(project.id);
                            showToast(
                              "Project ID copied to clipboard",
                              "success",
                            );
                            // Visual feedback
                            const button = e.currentTarget;
                            const originalHTML = button.innerHTML;
                            button.innerHTML =
                              '<svg class="w-3 h-3 mr-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>Copied!';
                            setTimeout(() => {
                              button.innerHTML = originalHTML;
                            }, 2000);
                          }}
                          className="flex-1 flex items-center justify-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors py-1"
                          title="Copy Project ID to clipboard"
                        >
                          <Clipboard className="w-3 h-3" />
                          <span>Copy ID</span>
                        </button>

                        {/* Delete button */}
                        <button
                          onClick={(e) =>
                            handleDeleteProject(e, project.id, project.title)
                          }
                          className="p-1.5 rounded-full bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-600 dark:bg-gray-800/70 dark:text-gray-400 dark:hover:bg-red-900/30 dark:hover:text-red-400 transition-colors"
                          title="Delete project"
                          aria-label="Delete project"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Project Details Section */}
      {showProjectDetails && selectedProject && (
        <motion.div variants={itemVariants} className="relative">
          {/* Loading overlay when switching projects */}
          {isSwitchingProject && (
            <div className="absolute inset-0 bg-white/50 dark:bg-black/50 backdrop-blur-sm z-40 flex items-center justify-center rounded-lg">
              <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl">
                <div className="flex items-center gap-3">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500"></div>
                  <span className="text-gray-700 dark:text-gray-300 font-medium">
                    Loading project...
                  </span>
                </div>
              </div>
            </div>
          )}
          
          <Tabs
            defaultValue="tasks"
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full"
          >
            <TabsList>
              <TabsTrigger
                value="docs"
                className="py-3 font-mono transition-all duration-300"
                color="blue"
              >
                Docs
              </TabsTrigger>
              {/* <TabsTrigger value="features" className="py-3 font-mono transition-all duration-300" color="purple">
                Features
              </TabsTrigger>
              <TabsTrigger value="data" className="py-3 font-mono transition-all duration-300" color="pink">
                Data
              </TabsTrigger> */}
              <TabsTrigger
                value="tasks"
                className="py-3 font-mono transition-all duration-300"
                color="orange"
              >
                Tasks
              </TabsTrigger>
            </TabsList>

            {/* Tab content without AnimatePresence to prevent unmounting */}
            <div>
              {activeTab === "docs" && (
                <TabsContent value="docs" className="mt-0">
                  <DocsTab tasks={tasks} project={selectedProject} />
                </TabsContent>
              )}
              {/* {activeTab === 'features' && (
                <TabsContent value="features" className="mt-0">
                  <FeaturesTab project={selectedProject} />
                </TabsContent>
              )}
              {activeTab === 'data' && (
                <TabsContent value="data" className="mt-0">
                  <DataTab project={selectedProject} />
                </TabsContent>
              )} */}
              {activeTab === "tasks" && (
                <TabsContent value="tasks" className="mt-0">
                  {isLoadingTasks ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="text-center">
                        <Loader2 className="w-6 h-6 text-orange-500 mx-auto mb-4 animate-spin" />
                        <p className="text-gray-600 dark:text-gray-400">
                          Loading tasks...
                        </p>
                      </div>
                    </div>
                  ) : tasksError ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="text-center">
                        <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-4" />
                        <p className="text-red-600 dark:text-red-400 mb-4">
                          {tasksError}
                        </p>
                        <Button
                          onClick={() =>
                            loadTasksForProject(selectedProject.id)
                          }
                          variant="primary"
                          accentColor="purple"
                        >
                          Retry
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <TasksTab
                      initialTasks={tasks}
                      onTasksChange={(updatedTasks) => {
                        setTasks(updatedTasks);
                        // Refresh task counts for all projects when tasks change
                        const projectIds = projects
                          .map((p) => p.id)
                          .filter((id) => !id.startsWith("temp-"));
                        loadTaskCountsForAllProjects(projectIds);
                      }}
                      projectId={selectedProject.id}
                    />
                  )}
                </TabsContent>
              )}
            </div>
          </Tabs>
        </motion.div>
      )}

      {/* New Project Modal */}
      {isNewProjectModalOpen && (
        <div className="fixed inset-0 bg-black/50 dark:bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
          <div
            className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
              bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
              border border-gray-200 dark:border-zinc-800/50
              shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
              before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
              before:rounded-t-[4px] before:bg-purple-500 
              before:shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]
              after:content-[''] after:absolute after:top-0 after:left-0 after:right-0 after:h-16
              after:bg-gradient-to-b after:from-purple-100 after:to-white dark:after:from-purple-500/20 dark:after:to-purple-500/5
              after:rounded-t-md after:pointer-events-none"
          >
            <div className="relative z-10">
              {/* Project Creation Form */}
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-fuchsia-500 text-transparent bg-clip-text">
                  Create New Project
                </h3>
                <button
                  onClick={() => setIsNewProjectModalOpen(false)}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-gray-700 dark:text-gray-300 mb-1">
                    Project Name
                  </label>
                  <input
                    type="text"
                    placeholder="Enter project name..."
                    value={newProjectForm.title}
                    onChange={(e) =>
                      setNewProjectForm((prev) => ({
                        ...prev,
                        title: e.target.value,
                      }))
                    }
                    className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-purple-400 focus:shadow-[0_0_10px_rgba(168,85,247,0.2)] transition-all duration-300"
                  />
                </div>
                <div>
                  <label className="block text-gray-700 dark:text-gray-300 mb-1">
                    Description
                  </label>
                  <textarea
                    placeholder="Enter project description..."
                    rows={4}
                    value={newProjectForm.description}
                    onChange={(e) =>
                      setNewProjectForm((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                    className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-purple-400 focus:shadow-[0_0_10px_rgba(168,85,247,0.2)] transition-all duration-300"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <Button
                  onClick={() => setIsNewProjectModalOpen(false)}
                  variant="ghost"
                  disabled={createProjectMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateProject}
                  variant="primary"
                  accentColor="purple"
                  className="shadow-lg shadow-purple-500/20"
                  disabled={
                    createProjectMutation.isPending ||
                    !newProjectForm.title.trim()
                  }
                >
                  {createProjectMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create Project"
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && projectToDelete && (
        <DeleteConfirmModal
          itemName={projectToDelete.title}
          onConfirm={confirmDeleteProject}
          onCancel={cancelDeleteProject}
          type="project"
        />
      )}
    </motion.div>
  );
}

export { ProjectPage, DeleteConfirmModal };
