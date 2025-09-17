import { motion } from "framer-motion";
import { Activity, CheckCircle2, ListTodo, Settings } from "lucide-react";
import type React from "react";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/primitives";
import { cn, glassmorphism } from "../../ui/primitives/styles";
import { DocsTab } from "../documents/DocsTab";
import { TasksTab } from "../tasks/TasksTab";
import type { Project } from "../types";

interface ProjectMainContentProps {
  selectedProject: Project | null;
  taskCounts: Record<string, { todo: number; doing: number; review: number; done: number }>;
  activeTab: string;
  onTabChange: (tab: string) => void;
  className?: string;
}

interface ProjectStatsHeaderProps {
  project: Project;
  taskCounts: {
    todo: number;
    doing: number;
    review: number;
    done: number;
  };
}

const ProjectStatsHeader: React.FC<ProjectStatsHeaderProps> = ({ project, taskCounts }) => {
  const totalTasks = taskCounts.todo + taskCounts.doing + taskCounts.review + taskCounts.done;
  const activeTasks = taskCounts.doing + taskCounts.review;
  const completionPercentage = totalTasks > 0 ? Math.round((taskCounts.done / totalTasks) * 100) : 0;

  return (
    <div className={cn("p-6 border-b", glassmorphism.border.default)}>
      {/* Project Title and Description */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{project.title}</h1>
          {project.description && (
            <p className="text-gray-600 dark:text-gray-400 text-sm line-clamp-2">{project.description}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" className="p-2">
          <Settings className="w-4 h-4" />
        </Button>
      </div>

      {/* Task Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Todo Tasks */}
        <motion.div
          className={cn(
            "flex items-center gap-3 p-4 rounded-lg border",
            glassmorphism.background.subtle,
            glassmorphism.border.default,
            "hover:shadow-md transition-shadow duration-200",
          )}
          whileHover={{ scale: 1.02 }}
        >
          <div className="p-2 rounded-full bg-pink-100 dark:bg-pink-900/30">
            <ListTodo className="w-5 h-5 text-pink-600 dark:text-pink-400" />
          </div>
          <div>
            <div className="font-bold text-lg text-gray-900 dark:text-white">{taskCounts.todo}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium">Todo</div>
          </div>
        </motion.div>

        {/* Active Tasks (Doing + Review) */}
        <motion.div
          className={cn(
            "flex items-center gap-3 p-4 rounded-lg border",
            glassmorphism.background.subtle,
            glassmorphism.border.default,
            "hover:shadow-md transition-shadow duration-200",
          )}
          whileHover={{ scale: 1.02 }}
        >
          <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
            <Activity className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <div className="font-bold text-lg text-gray-900 dark:text-white">{activeTasks}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium">Active</div>
          </div>
        </motion.div>

        {/* Done Tasks */}
        <motion.div
          className={cn(
            "flex items-center gap-3 p-4 rounded-lg border",
            glassmorphism.background.subtle,
            glassmorphism.border.default,
            "hover:shadow-md transition-shadow duration-200",
          )}
          whileHover={{ scale: 1.02 }}
        >
          <div className="p-2 rounded-full bg-green-100 dark:bg-green-900/30">
            <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
          </div>
          <div>
            <div className="font-bold text-lg text-gray-900 dark:text-white">{taskCounts.done}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium">Done</div>
          </div>
        </motion.div>

        {/* Progress Summary */}
        <motion.div
          className={cn(
            "flex items-center gap-3 p-4 rounded-lg border",
            glassmorphism.background.subtle,
            glassmorphism.border.default,
            "hover:shadow-md transition-shadow duration-200",
          )}
          whileHover={{ scale: 1.02 }}
        >
          <div className="p-2 rounded-full bg-purple-100 dark:bg-purple-900/30">
            <div className="w-5 h-5 flex items-center justify-center">
              <span className="text-xs font-bold text-purple-600 dark:text-purple-400">{completionPercentage}%</span>
            </div>
          </div>
          <div>
            <div className="font-bold text-lg text-gray-900 dark:text-white">{totalTasks}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-medium">Total</div>
          </div>
        </motion.div>
      </div>

      {/* Progress Bar */}
      {totalTasks > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Progress</span>
            <span className="text-sm text-gray-500 dark:text-gray-400">{completionPercentage}% Complete</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <motion.div
              className="h-2 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${completionPercentage}%` }}
              transition={{ duration: 1, ease: "easeOut" }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export const ProjectMainContent: React.FC<ProjectMainContentProps> = ({
  selectedProject,
  taskCounts,
  activeTab,
  onTabChange,
  className,
}) => {
  if (!selectedProject) {
    return (
      <div className={cn("flex-1 flex items-center justify-center", className)}>
        <div className="text-center">
          <div className="mb-4">
            <img
              src="/logo-neon.png"
              alt="No project selected"
              className="w-16 h-16 mx-auto opacity-50 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]"
            />
          </div>
          <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">Select a project</h2>
          <p className="text-gray-500 dark:text-gray-400">
            Choose a project from the sidebar to view its tasks and documents
          </p>
        </div>
      </div>
    );
  }

  const projectTaskCounts = taskCounts[selectedProject.id] || { todo: 0, doing: 0, review: 0, done: 0 };

  return (
    <motion.div
      className={cn("flex-1 flex flex-col", className)}
      variants={itemVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Project Header with Stats */}
      <ProjectStatsHeader project={selectedProject} taskCounts={projectTaskCounts} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        <Tabs defaultValue="tasks" value={activeTab} onValueChange={onTabChange} className="flex-1 flex flex-col">
          <div className="px-6 pt-4">
            <TabsList>
              <TabsTrigger value="tasks" className="py-3 font-mono transition-all duration-300" color="orange">
                Tasks
                <span className="ml-2 px-2 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 text-xs rounded-full">
                  {projectTaskCounts.todo + projectTaskCounts.doing + projectTaskCounts.review}
                </span>
              </TabsTrigger>
              <TabsTrigger value="docs" className="py-3 font-mono transition-all duration-300" color="blue">
                Docs
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col min-h-0">
            {activeTab === "tasks" && (
              <TabsContent value="tasks" className="flex-1 flex flex-col mt-0">
                <TasksTab projectId={selectedProject.id} />
              </TabsContent>
            )}
            {activeTab === "docs" && (
              <TabsContent value="docs" className="flex-1 flex flex-col mt-0">
                <DocsTab project={selectedProject} />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </motion.div>
  );
};
