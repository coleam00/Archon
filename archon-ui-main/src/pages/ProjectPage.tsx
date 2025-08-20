import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../contexts/ToastContext';
import { motion, AnimatePresence } from 'framer-motion';
import { useStaggeredEntrance } from '../hooks/useStaggeredEntrance';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/project-tasks/Tabs';
import { DocsTab } from '../components/project-tasks/DocsTab';
// import { FeaturesTab } from '../components/project-tasks/FeaturesTab';
// import { DataTab } from '../components/project-tasks/DataTab';
import { TasksTab } from '../components/project-tasks/TasksTab';
import { Button } from '../components/ui/Button';
import { ChevronRight, ShoppingCart, Code, Briefcase, Layers, Plus, X, AlertCircle, Loader2, Heart, BarChart3, Trash2, Pin, ListTodo, Activity, CheckCircle2, Clipboard } from 'lucide-react';

// Import our service layer and types
import { projectService } from '../services/projectService';
import type { Project, CreateProjectRequest } from '../types/project';
import type { Task } from '../components/project-tasks/TaskTableView';
import { ProjectCreationProgressCard } from '../components/ProjectCreationProgressCard';
import { projectCreationProgressService } from '../services/projectCreationProgressService';
import type { ProjectCreationProgressData } from '../services/projectCreationProgressService';
import { projectListSocketIO, taskUpdateSocketIO } from '../services/socketIOService';

interface ProjectPageProps {
  className?: string;
  'data-id'?: string;
}

// Icon mapping for projects (since database stores icon names as strings)
const getProjectIcon = (iconName?: string) => {
  const iconMap = {
    'ShoppingCart': <ShoppingCart className="w-5 h-5" />,
    'Briefcase': <Briefcase className="w-5 h-5" />,
    'Code': <Code className="w-5 h-5" />,
    'Layers': <Layers className="w-5 h-5" />,
    'BarChart': <BarChart3 className="w-5 h-5" />,
    'Heart': <Heart className="w-5 h-5" />,
  };
  return iconMap[iconName as keyof typeof iconMap] || <Briefcase className="w-5 h-5" />;
};

export function ProjectPage({
  className = '',
  'data-id': dataId
}: ProjectPageProps) {
  // State management for real data
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectTaskCounts, setProjectTaskCounts] = useState<Record<string, { todo: number; doing: number; done: number }>>({});
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [tasksError, setTasksError] = useState<string | null>(null);
  
  // UI state
  const [activeTab, setActiveTab] = useState('tasks');
  const [showProjectDetails, setShowProjectDetails] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  
  // New project form state
  const [newProjectForm, setNewProjectForm] = useState({
    title: '',
    description: '',
    color: 'blue' as const
  });
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  
  // Handler for retrying project creation
  const handleRetryProjectCreation = (progressId: string) => {
    // Remove the failed project
    setProjects((prev) => prev.filter(p => p.id !== `temp-${progressId}`));
    // Re-open the modal for retry
    setIsNewProjectModalOpen(true);
  };

  // State for delete confirmation modal
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; title: string } | null>(null);

  const { showToast } = useToast();

  // Load projects on mount - simplified approach
  useEffect(() => {
    const loadProjectsData = async () => {
      try {
        console.log('🚀 Loading projects...');
        setIsLoadingProjects(true);
        setProjectsError(null);
        
        const projectsData = await projectService.listProjects();
        console.log(`📦 Received ${projectsData.length} projects from API`);
        
        // Log each project's pinned status
        projectsData.forEach(p => {
          console.log(`  - ${p.title}: pinned=${p.pinned} (type: ${typeof p.pinned})`);
        });
        
        // Sort projects - pinned first, then alphabetically
        const sortedProjects = [...projectsData].sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return a.title.localeCompare(b.title);
        });
        
        setProjects(sortedProjects);
        
        // Load task counts for all projects
        const projectIds = sortedProjects.map(p => p.id);
        loadTaskCountsForAllProjects(projectIds);
        
        // Find pinned project - this is ALWAYS the default on page load
        const pinnedProject = sortedProjects.find(p => p.pinned === true);
        console.log(`📌 Pinned project:`, pinnedProject ? `${pinnedProject.title} (pinned=${pinnedProject.pinned})` : 'None found');
        
        // Debug: Log all projects and their pinned status
        console.log('📋 All projects with pinned status:');
        sortedProjects.forEach(p => {
          console.log(`   - ${p.title}: pinned=${p.pinned} (type: ${typeof p.pinned})`);
        });
        
        // On page load, ALWAYS select pinned project if it exists
        if (pinnedProject) {
          console.log(`✅ Selecting pinned project: ${pinnedProject.title}`);
          setSelectedProject(pinnedProject);
          setShowProjectDetails(true);
          setActiveTab('tasks');
          // Small delay to let Socket.IO connections establish
          setTimeout(() => {
            loadTasksForProject(pinnedProject.id);
          }, 100);
        } else if (sortedProjects.length > 0) {
          // No pinned project, select first one
          const firstProject = sortedProjects[0];
          console.log(`📋 No pinned project, selecting first: ${firstProject.title}`);
          setSelectedProject(firstProject);
          setShowProjectDetails(true);
          setActiveTab('tasks');
          // Small delay to let Socket.IO connections establish
          setTimeout(() => {
            loadTasksForProject(firstProject.id);
          }, 100);
        }
        
        setIsLoadingProjects(false);
      } catch (error) {
        console.error('Failed to load projects:', error);
        setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
        setIsLoadingProjects(false);
      }
    };
    
    loadProjectsData();
  }, []); // Only run once on mount

  // Set up Socket.IO for real-time project list updates (after initial load)
  useEffect(() => {
    console.log('📡 Setting up Socket.IO for project list updates');
    
    const connectWebSocket = async () => {
      try {
        await projectListSocketIO.connect('/');
        projectListSocketIO.send({ type: 'subscribe_projects' });
        
        const handleProjectUpdate = (message: any) => {
          console.log('📨 Received project list update via Socket.IO');
          if (message.data && message.data.projects) {
            const projectsData = message.data.projects;
            
            // Sort projects - pinned first, then alphabetically
            const sortedProjects = [...projectsData].sort((a, b) => {
              if (a.pinned && !b.pinned) return -1;
              if (!a.pinned && b.pinned) return 1;
              return a.title.localeCompare(b.title);
            });
            
            setProjects(prev => {
              // Keep temp projects and merge with real projects
              const tempProjects = prev.filter(p => p.id.startsWith('temp-'));
              return [...tempProjects, ...sortedProjects];
            });
            
            // Refresh task counts
            const projectIds = sortedProjects.map(p => p.id);
            loadTaskCountsForAllProjects(projectIds);
          }
        };
        
        projectListSocketIO.addMessageHandler('projects_update', handleProjectUpdate);
        
        return () => {
          projectListSocketIO.removeMessageHandler('projects_update', handleProjectUpdate);
        };
      } catch (error) {
        console.error('Failed to connect project list Socket.IO:', error);
      }
    };
    
    const cleanup = connectWebSocket();
    
    return () => {
      console.log('🧹 Disconnecting project list Socket.IO');
      projectListSocketIO.disconnect();
      cleanup.then(cleanupFn => cleanupFn && cleanupFn());
    };
  }, []); // Only run once on mount

  // Load task counts for all projects
  const loadTaskCountsForAllProjects = useCallback(async (projectIds: string[]) => {
    try {
      const counts: Record<string, { todo: number; doing: number; done: number }> = {};
      
      for (const projectId of projectIds) {
        try {
          const tasksData = await projectService.getTasksByProject(projectId);
          const todos = tasksData.filter(t => t.uiStatus === 'backlog').length;
          const doing = tasksData.filter(t => t.uiStatus === 'in-progress' || t.uiStatus === 'review').length;
          const done = tasksData.filter(t => t.uiStatus === 'complete').length;
          
          counts[projectId] = { todo: todos, doing, done };
        } catch (error) {
          console.error(`Failed to load tasks for project ${projectId}:`, error);
          counts[projectId] = { todo: 0, doing: 0, done: 0 };
        }
      }
      
      setProjectTaskCounts(counts);
    } catch (error) {
      console.error('Failed to load task counts:', error);
    }
  }, []);

  // Load tasks when project is selected
  useEffect(() => {
    if (selectedProject) {
      loadTasksForProject(selectedProject.id);
    }
  }, [selectedProject]);

  // Removed localStorage persistence for selected project
  // We always want to load the pinned project on page refresh

  // Set up Socket.IO for real-time task count updates for selected project
  useEffect(() => {
    if (!selectedProject) return;

    console.log('🔌 Setting up Socket.IO for project task updates:', selectedProject.id);
    
    // Store the project room in localStorage for reconnection
    localStorage.setItem('lastProjectRoom', selectedProject.id);
    
    // Define handlers outside so they can be removed in cleanup
    const handleTaskCreated = () => {
      console.log('✅ Task created - refreshing counts for all projects');
      const projectIds = projects.map(p => p.id).filter(id => !id.startsWith('temp-'));
      loadTaskCountsForAllProjects(projectIds);
    };
    
    const handleTaskUpdated = () => {
      console.log('✅ Task updated - refreshing counts for all projects');
      const projectIds = projects.map(p => p.id).filter(id => !id.startsWith('temp-'));
      loadTaskCountsForAllProjects(projectIds);
    };
    
    const handleTaskDeleted = () => {
      console.log('✅ Task deleted - refreshing counts for all projects');
      const projectIds = projects.map(p => p.id).filter(id => !id.startsWith('temp-'));
      loadTaskCountsForAllProjects(projectIds);
    };
    
    const handleTaskArchived = () => {
      console.log('✅ Task archived - refreshing counts for all projects');
      const projectIds = projects.map(p => p.id).filter(id => !id.startsWith('temp-'));
      loadTaskCountsForAllProjects(projectIds);
    };
    
    const connectWebSocket = async () => {
      try {
        // Check if already connected
        if (!taskUpdateSocketIO.isConnected()) {
          await taskUpdateSocketIO.connect('/');
        }
        
        // Always join the project room (even if already connected)
        taskUpdateSocketIO.send({ type: 'join_project', project_id: selectedProject.id });
        
        // Add event handlers
        taskUpdateSocketIO.addMessageHandler('task_created', handleTaskCreated);
        taskUpdateSocketIO.addMessageHandler('task_updated', handleTaskUpdated);
        taskUpdateSocketIO.addMessageHandler('task_deleted', handleTaskDeleted);
        taskUpdateSocketIO.addMessageHandler('task_archived', handleTaskArchived);
        
      } catch (error) {
        console.error('Failed to connect task Socket.IO:', error);
      }
    };

    connectWebSocket();

    return () => {
      // Don't disconnect the shared taskUpdateSocketIO - let TasksTab manage it
      console.log('🔌 Cleaning up task Socket.IO handlers');
      // Just remove the handlers, don't disconnect
      taskUpdateSocketIO.removeMessageHandler('task_created', handleTaskCreated);
      taskUpdateSocketIO.removeMessageHandler('task_updated', handleTaskUpdated);
      taskUpdateSocketIO.removeMessageHandler('task_deleted', handleTaskDeleted);
      taskUpdateSocketIO.removeMessageHandler('task_archived', handleTaskArchived);
    };
  }, [selectedProject?.id]);

  const loadProjects = async () => {
    try {
      console.log(`[LOAD PROJECTS] Starting loadProjects...`);
      setIsLoadingProjects(true);
      setProjectsError(null);
      
      const projectsData = await projectService.listProjects();
      console.log(`[LOAD PROJECTS] Projects loaded from API:`, projectsData.map(p => ({id: p.id, title: p.title, pinned: p.pinned})));
      
      // Sort projects - pinned first, then alphabetically by title
      const sortedProjects = [...projectsData].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return a.title.localeCompare(b.title);
      });
      console.log(`[LOAD PROJECTS] Projects after sorting:`, sortedProjects.map(p => ({id: p.id, title: p.title, pinned: p.pinned})));
      
      setProjects(sortedProjects);
      
      // Load task counts for all projects
      const projectIds = sortedProjects.map(p => p.id);
      loadTaskCountsForAllProjects(projectIds);
      
      // Find pinned project if any
      const pinnedProject = sortedProjects.find(project => project.pinned === true);
      console.log(`[LOAD PROJECTS] Pinned project:`, pinnedProject ? pinnedProject.title : 'None');
      
      // Always select pinned project if it exists
      if (pinnedProject) {
        console.log(`[LOAD PROJECTS] Selecting pinned project: ${pinnedProject.title}`);
        setSelectedProject(pinnedProject);
        setShowProjectDetails(true);
        setActiveTab('tasks');
        loadTasksForProject(pinnedProject.id);
      } else if (!selectedProject && sortedProjects.length > 0) {
        // No pinned project and no selection, select first project
        console.log(`[LOAD PROJECTS] No pinned project, selecting first project: ${sortedProjects[0].title}`);
        setSelectedProject(sortedProjects[0]);
        setShowProjectDetails(true);
        setActiveTab('tasks');
        loadTasksForProject(sortedProjects[0].id);
      } else {
        console.log(`[LOAD PROJECTS] Keeping current project selection`);
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
      setProjectsError(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const loadTasksForProject = async (projectId: string) => {
    try {
      setIsLoadingTasks(true);
      setTasksError(null);
      
      const tasksData = await projectService.getTasksByProject(projectId);
      
             // Convert backend tasks to UI format
       const uiTasks: Task[] = tasksData.map(task => ({
         id: task.id,
         title: task.title,
         description: task.description,
         status: (task.uiStatus || 'backlog') as Task['status'],
         assignee: {
           name: (task.assignee || 'User') as 'User' | 'Archon' | 'AI IDE Agent',
           avatar: ''
         },
         feature: task.feature || 'General',
         featureColor: task.featureColor || '#6366f1',
         task_order: task.task_order || 0
       }));
       
       setTasks(uiTasks);
    } catch (error) {
      console.error('Failed to load tasks:', error);
      setTasksError(error instanceof Error ? error.message : 'Failed to load tasks');
    } finally {
      setIsLoadingTasks(false);
    }
  };

  const handleProjectSelect = (project: Project) => {
    setSelectedProject(project);
    setShowProjectDetails(true);
    setActiveTab('tasks'); // Default to tasks tab when a new project is selected
    loadTasksForProject(project.id); // Load tasks for the selected project
  };

  const handleDeleteProject = useCallback(async (e: React.MouseEvent, projectId: string, projectTitle: string) => {
    e.stopPropagation();
    setProjectToDelete({ id: projectId, title: projectTitle });
    setShowDeleteConfirm(true);
  }, [setProjectToDelete, setShowDeleteConfirm]);

  const confirmDeleteProject = useCallback(async () => {
    if (!projectToDelete) return;

    try {
      await projectService.deleteProject(projectToDelete.id);
      
      // Update UI
      setProjects(prev => prev.filter(p => p.id !== projectToDelete.id));
      
      if (selectedProject?.id === projectToDelete.id) {
        setSelectedProject(null);
        setShowProjectDetails(false);
      }
      
      showToast(`Project "${projectToDelete.title}" deleted successfully`, 'success');
    } catch (error) {
      console.error('Failed to delete project:', error);
      showToast('Failed to delete project. Please try again.', 'error');
    } finally {
      setShowDeleteConfirm(false);
      setProjectToDelete(null);
    }
  }, [projectToDelete, setProjects, selectedProject, setSelectedProject, setShowProjectDetails, showToast, setShowDeleteConfirm, setProjectToDelete]);

  const cancelDeleteProject = useCallback(() => {
    setShowDeleteConfirm(false);
    setProjectToDelete(null);
  }, [setShowDeleteConfirm, setProjectToDelete]);
  
  const handleTogglePin = useCallback(async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    
    const newPinnedState = !project.pinned;
    console.log(`[PIN] Toggling pin for project ${project.id} (${project.title}) to ${newPinnedState}`);
    
    try {
      // Update the backend first
      console.log(`[PIN] Sending update to backend: project ${project.id}, pinned=${newPinnedState}`);
      const updatedProject = await projectService.updateProject(project.id, {
        pinned: newPinnedState
      });
      console.log(`[PIN] Backend response:`, updatedProject);
      
      // Update local state to reflect the change immediately
      setProjects(prev => {
        if (newPinnedState) {
          // If pinning: unpin all others and update this one
          console.log(`[PIN] Pinning project ${project.title} - unpinning all others`);
          const updated = prev.map(p => ({
            ...p,
            pinned: p.id === project.id ? true : false
          }));
          
          // Re-sort with the newly pinned project first
          return updated.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return a.title.localeCompare(b.title);
          });
        } else {
          // Just unpin this project
          console.log(`[PIN] Unpinning project ${project.title}`);
          return prev.map(p => 
            p.id === project.id ? { ...p, pinned: false } : p
          );
        }
      });
      
      // If pinning a project, also select it
      if (newPinnedState) {
        console.log(`[PIN] Selecting newly pinned project: ${project.title}`);
        setSelectedProject({ ...project, pinned: true });
        setShowProjectDetails(true);
        setActiveTab('tasks'); // Default to tasks tab
        loadTasksForProject(project.id);
      } else if (selectedProject?.id === project.id) {
        // If unpinning the currently selected project, just update its pin state
        console.log(`[PIN] Updating selected project's pin state`);
        setSelectedProject(prev => prev ? { ...prev, pinned: false } : null);
      }
      
      showToast(
        newPinnedState 
          ? `Pinned "${project.title}" to top` 
          : 'Removed from pinned projects',
        'info'
      );
    } catch (error) {
      console.error('Failed to update project pin status:', error);
      showToast('Failed to update project. Please try again.', 'error');
    }
  }, [projectService, setProjects, selectedProject, setSelectedProject, showToast]);

  const handleCreateProject = async () => {
    if (!newProjectForm.title.trim()) {
      return;
    }

    try {
      setIsCreatingProject(true);
      
      const projectData: CreateProjectRequest = {
        title: newProjectForm.title,
        description: newProjectForm.description,
        color: newProjectForm.color,
        icon: 'Briefcase', // Default icon
        // PRD data will be added as a document in the docs array by backend
        docs: [],
        features: [],
        data: []
      };

      // Call the streaming project creation API
      const response = await projectService.createProjectWithStreaming(projectData);
      
      if (response.progress_id) {
        // Create a temporary project with progress tracking
        const tempId = `temp-${response.progress_id}`;
        const tempProject: Project = {
          id: tempId,
          title: newProjectForm.title,
          description: newProjectForm.description || '',
          github_repo: undefined,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          docs: [],
          features: [],
          data: [],
          pinned: false,
          color: newProjectForm.color,
          icon: 'Briefcase',
          creationProgress: {
            progressId: response.progress_id,
            status: 'starting',
            percentage: 0,
            logs: ['🚀 Starting project creation...'],
            project: undefined
          }
        };
        
        // Add temporary project to the list
        setProjects((prev) => [tempProject, ...prev]);
        
        // Close modal immediately
        setIsNewProjectModalOpen(false);
        setNewProjectForm({ title: '', description: '' });
        setIsCreatingProject(false);
        
        // Set up Socket.IO connection for real-time progress
        projectCreationProgressService.streamProgress(
          response.progress_id,
          (data: ProjectCreationProgressData) => {
            console.log(`🎯 [PROJECT-PAGE] Progress callback triggered for ${response.progress_id}:`, data);
            console.log(`🎯 [PROJECT-PAGE] Status: ${data.status}, Percentage: ${data.percentage}, Step: ${data.step}`);
            
            // Always update the temporary project's progress - this will trigger the card's useEffect
            setProjects((prev) => {
              const updated = prev.map(p => 
                p.id === tempId 
                  ? { ...p, creationProgress: data }
                  : p
              );
              console.log(`🎯 [PROJECT-PAGE] Updated projects state with progress data`);
              return updated;
            });
            
            // Handle error state
            if (data.status === 'error') {
              console.log(`🎯 [PROJECT-PAGE] Error status detected, will remove project after delay`);
              // Remove failed project after delay
              setTimeout(() => {
                setProjects((prev) => prev.filter(p => p.id !== tempId));
              }, 5000);
            }
          },
          { autoReconnect: true, reconnectDelay: 5000 }
        );
      } else {
        // Fallback to old synchronous flow
        const newProject = await projectService.createProject(projectData);
        
        setProjects((prev) => [...prev, newProject]);
        setSelectedProject(newProject);
        setShowProjectDetails(true);
        
        setNewProjectForm({ title: '', description: '' });
        setIsNewProjectModalOpen(false);
        setIsCreatingProject(false);
      }
      
      console.log('✅ Project creation initiated successfully');
    } catch (error) {
      console.error('Failed to create project:', error);
      setIsCreatingProject(false);
      showToast(
        error instanceof Error ? error.message : 'Failed to create project. Please try again.',
        'error'
      );
    }
  };

  // Add staggered entrance animations
  const {
    isVisible,
    containerVariants,
    itemVariants,
    titleVariants
  } = useStaggeredEntrance([1, 2, 3], 0.15);

  // Add animation for tab content
  const tabContentVariants = {
    hidden: {
      opacity: 0,
      y: 20
    },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.4,
        ease: 'easeOut'
      }
    },
    exit: {
      opacity: 0,
      y: -20,
      transition: {
        duration: 0.2
      }
    }
  };

  return (
    <motion.div 
      initial="hidden" 
      animate={isVisible ? 'visible' : 'hidden'} 
      variants={containerVariants} 
      className={`max-w-full mx-auto ${className}`} 
      data-id={dataId}
    >
      {/* Page Header with New Project Button */}
      <motion.div className="flex items-center justify-between mb-8" variants={itemVariants}>
        <motion.h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3" variants={titleVariants}>
          <img src="/logo-neon.png" alt="Projects" className="w-7 h-7 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
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
              <p className="text-gray-600 dark:text-gray-400">Loading your projects...</p>
            </div>
          </div>
        </motion.div>
      )}

      {projectsError && (
        <motion.div variants={itemVariants} className="mb-10">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
              <p className="text-red-600 dark:text-red-400 mb-4">{projectsError}</p>
              <Button onClick={loadProjects} variant="primary" accentColor="purple">
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
              {projects.map(project => (
                project.creationProgress ? (
                  // Show progress card for projects being created
                  <motion.div 
                    key={project.id} 
                    variants={itemVariants}
                    className="w-72"
                  >
                    <ProjectCreationProgressCard
                      progressData={project.creationProgress}
                      onComplete={(completedData) => {
                        console.log('Project creation completed - card onComplete triggered', completedData);
                        
                        if (completedData.project && completedData.status === 'completed') {
                          // Show success toast
                          showToast(`Project "${completedData.project.title}" created successfully!`, 'success');
                          
                          // Show completion briefly, then refresh to show the actual project
                          setTimeout(() => {
                            // Disconnect Socket.IO
                            projectCreationProgressService.disconnect();
                            
                            // Remove temp project 
                            setProjects((prev) => prev.filter(p => p.id !== project.id));
                            
                            // The project list will be updated via Socket.IO broadcast
                            // No need to manually reload projects
                          }, 1000); // Reduced from 2000ms to 1000ms for faster refresh
                        }
                      }}
                      onError={(error) => {
                        console.error('Project creation failed:', error);
                        showToast(`Failed to create project: ${error}`, 'error');
                      }}
                      onRetry={() => handleRetryProjectCreation(project.creationProgress!.progressId)}
                    />
                  </motion.div>
                ) : (
                <motion.div 
                  key={project.id} 
                  variants={itemVariants} 
                  onClick={() => handleProjectSelect(project)} 
                  className={`
                    relative p-4 rounded-xl backdrop-blur-md w-72 cursor-pointer overflow-hidden
                    ${project.pinned
                      ? 'bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10'
                      : selectedProject?.id === project.id 
                        ? 'bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20' 
                        : 'bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30'
                    }
                    border ${project.pinned
                      ? 'border-purple-500/80 dark:border-purple-500/80 shadow-[0_0_15px_rgba(168,85,247,0.3)]'
                      : selectedProject?.id === project.id 
                        ? 'border-purple-400/60 dark:border-purple-500/60' 
                        : 'border-gray-200 dark:border-zinc-800/50'
                    }
                    ${selectedProject?.id === project.id
                      ? 'shadow-[0_0_15px_rgba(168,85,247,0.4),0_0_10px_rgba(147,51,234,0.3)] dark:shadow-[0_0_20px_rgba(168,85,247,0.5),0_0_15px_rgba(147,51,234,0.4)]'
                      : 'shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]'
                    }
                    hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.2)] dark:hover:shadow-[0_15px_40px_-15px_rgba(0,0,0,0.9)]
                    transition-all duration-300
                    ${selectedProject?.id === project.id ? 'translate-y-[-2px]' : 'hover:translate-y-[-2px]'}
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
                      <h3 className={`font-medium text-center leading-tight line-clamp-2 transition-all duration-300 ${
                        selectedProject?.id === project.id 
                          ? 'text-gray-900 dark:text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]' 
                          : 'text-gray-500 dark:text-gray-400'
                      }`}>
                        {project.title}
                      </h3>
                    </div>
                    <div className="flex items-stretch gap-2 w-full">
                      {/* Neon pill boxes for task counts */}
                      {/* Todo pill */}
                      <div className="relative flex-1">
                        <div className={`absolute inset-0 bg-pink-600 rounded-full blur-md ${selectedProject?.id === project.id ? 'opacity-30 dark:opacity-75' : 'opacity-0'}`}></div>
                        <div className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                          selectedProject?.id === project.id 
                            ? 'bg-white/70 dark:bg-zinc-900/90 border-pink-300 dark:border-pink-500/50 dark:shadow-[0_0_10px_rgba(236,72,153,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(236,72,153,0.7)]' 
                            : 'bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50'
                        }`}>
                          <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                            <ListTodo className={`w-4 h-4 ${selectedProject?.id === project.id ? 'text-pink-600 dark:text-pink-400' : 'text-gray-500 dark:text-gray-600'}`} />
                            <span className={`text-[8px] font-medium ${selectedProject?.id === project.id ? 'text-pink-600 dark:text-pink-400' : 'text-gray-500 dark:text-gray-600'}`}>ToDo</span>
                          </div>
                          <div className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? 'border-pink-300 dark:border-pink-500/30' : 'border-gray-300/50 dark:border-gray-700/50'}`}>
                            <span className={`text-lg font-bold ${selectedProject?.id === project.id ? 'text-pink-600 dark:text-pink-400' : 'text-gray-500 dark:text-gray-600'}`}>{projectTaskCounts[project.id]?.todo || 0}</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Doing pill */}
                      <div className="relative flex-1">
                        <div className={`absolute inset-0 bg-blue-600 rounded-full blur-md ${selectedProject?.id === project.id ? 'opacity-30 dark:opacity-75' : 'opacity-0'}`}></div>
                        <div className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                          selectedProject?.id === project.id 
                            ? 'bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(59,130,246,0.7)]' 
                            : 'bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50'
                        }`}>
                          <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                            <Activity className={`w-4 h-4 ${selectedProject?.id === project.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-600'}`} />
                            <span className={`text-[8px] font-medium ${selectedProject?.id === project.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-600'}`}>Doing</span>
                          </div>
                          <div className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? 'border-blue-300 dark:border-blue-500/30' : 'border-gray-300/50 dark:border-gray-700/50'}`}>
                            <span className={`text-lg font-bold ${selectedProject?.id === project.id ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-600'}`}>{projectTaskCounts[project.id]?.doing || 0}</span>
                          </div>
                        </div>
                      </div>
                      
                      {/* Done pill */}
                      <div className="relative flex-1">
                        <div className={`absolute inset-0 bg-green-600 rounded-full blur-md ${selectedProject?.id === project.id ? 'opacity-30 dark:opacity-75' : 'opacity-0'}`}></div>
                        <div className={`relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300 ${
                          selectedProject?.id === project.id 
                            ? 'bg-white/70 dark:bg-zinc-900/90 border-green-300 dark:border-green-500/50 dark:shadow-[0_0_10px_rgba(34,197,94,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(34,197,94,0.7)]' 
                            : 'bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50'
                        }`}>
                          <div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
                            <CheckCircle2 className={`w-4 h-4 ${selectedProject?.id === project.id ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-600'}`} />
                            <span className={`text-[8px] font-medium ${selectedProject?.id === project.id ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-600'}`}>Done</span>
                          </div>
                          <div className={`flex-1 flex items-center justify-center border-l ${selectedProject?.id === project.id ? 'border-green-300 dark:border-green-500/30' : 'border-gray-300/50 dark:border-gray-700/50'}`}>
                            <span className={`text-lg font-bold ${selectedProject?.id === project.id ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-600'}`}>{projectTaskCounts[project.id]?.done || 0}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Action buttons - At bottom of card */}
                    <div className="mt-3 pt-3 border-t border-gray-200/50 dark:border-gray-700/30 flex items-center justify-between gap-2">
                      {/* Pin button */}
                      <button
                        onClick={(e) => handleTogglePin(e, project)}
                        className={`p-1.5 rounded-full ${project.pinned === true ? 'bg-purple-100 text-purple-700 dark:bg-purple-700/30 dark:text-purple-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800/70 dark:text-gray-400'} hover:bg-purple-200 hover:text-purple-800 dark:hover:bg-purple-800/50 dark:hover:text-purple-300 transition-colors`}
                        title={project.pinned === true ? 'Unpin project' : 'Pin project'}
                        aria-label={project.pinned === true ? 'Unpin project' : 'Pin project'}
                        data-pinned={project.pinned}
                      >
                        <Pin className="w-3.5 h-3.5" fill={project.pinned === true ? 'currentColor' : 'none'} />
                      </button>
                      
                      {/* Copy Project ID Button */}
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(project.id);
                          showToast('Project ID copied to clipboard', 'success');
                          // Visual feedback
                          const button = e.currentTarget;
                          const originalHTML = button.innerHTML;
                          button.innerHTML = '<svg class="w-3 h-3 mr-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>Copied!';
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
                        onClick={(e) => handleDeleteProject(e, project.id, project.title)}
                        className="p-1.5 rounded-full bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-600 dark:bg-gray-800/70 dark:text-gray-400 dark:hover:bg-red-900/30 dark:hover:text-red-400 transition-colors"
                        title="Delete project"
                        aria-label="Delete project"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </motion.div>
                )
              ))}
            </div>
          </div>
        </motion.div>
      )}

      {/* Project Details Section */}
      {showProjectDetails && selectedProject && (
        <motion.div variants={itemVariants}>
          <Tabs defaultValue="tasks" value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList>
              <TabsTrigger value="docs" className="py-3 font-mono transition-all duration-300" color="blue">
                Docs
              </TabsTrigger>
              {/* <TabsTrigger value="features" className="py-3 font-mono transition-all duration-300" color="purple">
                Features
              </TabsTrigger>
              <TabsTrigger value="data" className="py-3 font-mono transition-all duration-300" color="pink">
                Data
              </TabsTrigger> */}
              <TabsTrigger value="tasks" className="py-3 font-mono transition-all duration-300" color="orange">
                Tasks
              </TabsTrigger>
            </TabsList>
            
            {/* Tab content without AnimatePresence to prevent unmounting */}
            <div>
              {activeTab === 'docs' && (
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
              {activeTab === 'tasks' && (
                <TabsContent value="tasks" className="mt-0">
                  {isLoadingTasks ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="text-center">
                        <Loader2 className="w-6 h-6 text-orange-500 mx-auto mb-4 animate-spin" />
                        <p className="text-gray-600 dark:text-gray-400">Loading tasks...</p>
                      </div>
                    </div>
                  ) : tasksError ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="text-center">
                        <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-4" />
                        <p className="text-red-600 dark:text-red-400 mb-4">{tasksError}</p>
                                                   <Button 
                           onClick={() => loadTasksForProject(selectedProject.id)} 
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
                        const projectIds = projects.map(p => p.id).filter(id => !id.startsWith('temp-'));
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
          <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
              bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
              border border-gray-200 dark:border-zinc-800/50
              shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
              before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
              before:rounded-t-[4px] before:bg-purple-500 
              before:shadow-[0_0_10px_2px_rgba(168,85,247,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(168,85,247,0.7)]
              after:content-[''] after:absolute after:top-0 after:left-0 after:right-0 after:h-16
              after:bg-gradient-to-b after:from-purple-100 after:to-white dark:after:from-purple-500/20 dark:after:to-purple-500/5
              after:rounded-t-md after:pointer-events-none">
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
                        onChange={(e) => setNewProjectForm((prev) => ({ ...prev, title: e.target.value }))}
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
                        onChange={(e) => setNewProjectForm((prev) => ({ ...prev, description: e.target.value }))}
                        className="w-full bg-white/50 dark:bg-black/70 border border-gray-300 dark:border-gray-700 text-gray-900 dark:text-white rounded-md py-2 px-3 focus:outline-none focus:border-purple-400 focus:shadow-[0_0_10px_rgba(168,85,247,0.2)] transition-all duration-300" 
                      />
                    </div>
                  </div>
                  
                  <div className="flex justify-end gap-3 mt-6">
                    <Button 
                      onClick={() => setIsNewProjectModalOpen(false)} 
                      variant="ghost"
                      disabled={isCreatingProject}
                    >
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleCreateProject} 
                      variant="primary" 
                      accentColor="purple" 
                      className="shadow-lg shadow-purple-500/20"
                      disabled={isCreatingProject || !newProjectForm.title.trim()}
                    >
                      {isCreatingProject ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        'Create Project'
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

// Reusable Delete Confirmation Modal Component
export interface DeleteConfirmModalProps {
  itemName: string;
  onConfirm: () => void;
  onCancel: () => void;
  type: 'project' | 'task' | 'client';
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ itemName, onConfirm, onCancel, type }) => {
  const getTitle = () => {
    switch (type) {
      case 'project': return 'Delete Project';
      case 'task': return 'Delete Task';
      case 'client': return 'Delete MCP Client';
    }
  };

  const getMessage = () => {
    switch (type) {
      case 'project': return `Are you sure you want to delete the "${itemName}" project? This will also delete all associated tasks and documents and cannot be undone.`;
      case 'task': return `Are you sure you want to delete the "${itemName}" task? This action cannot be undone.`;
      case 'client': return `Are you sure you want to delete the "${itemName}" client? This will permanently remove its configuration and cannot be undone.`;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="relative p-6 rounded-md backdrop-blur-md w-full max-w-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] 
          before:rounded-t-[4px] before:bg-red-500 
          before:shadow-[0_0_10px_2px_rgba(239,68,68,0.4)] dark:before:shadow-[0_0_20px_5px_rgba(239,68,68,0.7)]">
        
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