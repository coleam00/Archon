import {
  Activity,
  CheckCircle2,
  Copy,
  Edit,
  FileText,
  LayoutGrid,
  List,
  ListTodo,
  Pin,
  Search,
  Table as TableIcon,
  Tag,
  Trash2,
  User,
} from "lucide-react";
import { useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { Button } from "@/features/ui/primitives/button";
import { DraggableCard } from "@/features/ui/primitives/draggable-card";
import { Input } from "@/features/ui/primitives/input";
import { StatPill } from "@/features/ui/primitives/pill";
import { PillNavigation, type PillNavigationItem } from "@/features/ui/primitives/pill-navigation";
import { SelectableCard } from "@/features/ui/primitives/selectable-card";
import { cn } from "@/features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/features/ui/primitives/tooltip";

const MOCK_PROJECTS = [
  {
    id: "1",
    title: "Design System Refactor",
    pinned: true,
    taskCounts: { todo: 5, doing: 2, review: 1, done: 12 },
  },
  {
    id: "2",
    title: "API Integration Layer",
    pinned: false,
    taskCounts: { todo: 3, doing: 1, review: 0, done: 8 },
  },
  {
    id: "3",
    title: "Mobile App Development",
    pinned: false,
    taskCounts: { todo: 8, doing: 0, review: 0, done: 0 },
  },
  {
    id: "4",
    title: "Documentation Updates",
    pinned: false,
    taskCounts: { todo: 2, doing: 1, review: 2, done: 15 },
  },
];

const MOCK_TASKS = [
  {
    id: "1",
    title: "Update color palette",
    status: "todo" as const,
    assignee: "User",
    feature: "Design",
    priority: "high" as const,
  },
  {
    id: "2",
    title: "Refactor button component",
    status: "todo" as const,
    assignee: "AI",
    feature: "Components",
    priority: "medium" as const,
  },
  {
    id: "3",
    title: "Implement glassmorphism effects",
    status: "doing" as const,
    assignee: "User",
    feature: "Styling",
    priority: "high" as const,
  },
  {
    id: "4",
    title: "Add documentation",
    status: "review" as const,
    assignee: "User",
    feature: "Docs",
    priority: "low" as const,
  },
  {
    id: "5",
    title: "Setup project structure",
    status: "done" as const,
    assignee: "AI",
    feature: "Setup",
    priority: "high" as const,
  },
  {
    id: "6",
    title: "Create initial components",
    status: "done" as const,
    assignee: "User",
    feature: "Components",
    priority: "medium" as const,
  },
];

const MOCK_DOCUMENTS = [
  { id: "1", title: "Project Overview", type: "spec" as const },
  { id: "2", title: "API Documentation", type: "api" as const },
  { id: "3", title: "Design Notes", type: "note" as const },
];

export const ProjectsLayoutExample = () => {
  const [selectedId, setSelectedId] = useState("1");
  const [activeTab, setActiveTab] = useState<"docs" | "tasks">("tasks");
  const [viewMode, setViewMode] = useState<"board" | "table">("board");
  const [selectedDoc, setSelectedDoc] = useState(MOCK_DOCUMENTS[0]);
  const [layoutMode, setLayoutMode] = useState<"horizontal" | "sidebar">("horizontal");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);

  const selectedProject = MOCK_PROJECTS.find((p) => p.id === selectedId);

  const tabItems: PillNavigationItem[] = [
    { id: "docs", label: "Docs", icon: <FileText className="w-4 h-4" /> },
    { id: "tasks", label: "Tasks", icon: <ListTodo className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Layout Mode Toggle */}
      <div className="flex justify-end">
        <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayoutMode("horizontal")}
            className={cn("px-3", layoutMode === "horizontal" && "bg-purple-500/20 text-purple-400")}
            aria-label="Switch to horizontal layout"
            aria-pressed={layoutMode === "horizontal"}
          >
            <LayoutGrid className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayoutMode("sidebar")}
            className={cn("px-3", layoutMode === "sidebar" && "bg-purple-500/20 text-purple-400")}
            aria-label="Switch to sidebar layout"
            aria-pressed={layoutMode === "sidebar"}
          >
            <List className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {layoutMode === "horizontal" ? (
        <>
          {/* Horizontal Project Cards - ONLY cards scroll, not whole page */}
          <div className="w-full max-w-full">
            <div className="overflow-x-auto overflow-y-visible py-8 -mx-6 px-6 scrollbar-hide">
              <div className="flex gap-4 min-w-max">
                {MOCK_PROJECTS.map((project) => (
                  <ProjectCardExample
                    key={project.id}
                    project={project}
                    isSelected={selectedId === project.id}
                    onSelect={() => setSelectedId(project.id)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Orange Pill Navigation centered, View Toggle on right */}
          <div className="flex items-center justify-between">
            <div className="flex-1" />
            <PillNavigation
              items={tabItems}
              activeSection={activeTab}
              onSectionClick={(id) => setActiveTab(id as typeof activeTab)}
              colorVariant="orange"
              size="small"
              showIcons={true}
              showText={true}
              hasSubmenus={false}
            />
            <div className="flex-1 flex justify-end">
              {/* View Toggle aligned right */}
              {activeTab === "tasks" && (
                <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("board")}
                    className={cn("px-3", viewMode === "board" && "bg-cyan-500/20 text-cyan-400")}
                    aria-label="Board view"
                    aria-pressed={viewMode === "board"}
                  >
                    <LayoutGrid className="w-4 h-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("table")}
                    className={cn("px-3", viewMode === "table" && "bg-cyan-500/20 text-cyan-400")}
                    aria-label="Table view"
                    aria-pressed={viewMode === "table"}
                  >
                    <TableIcon className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Tab Content - NO extra margin */}
          <div>
            {activeTab === "tasks" && (viewMode === "board" ? <KanbanBoardView /> : <TaskTableView />)}
            {activeTab === "docs" && <EmbeddedDocumentBrowser doc={selectedDoc} onDocSelect={setSelectedDoc} />}
          </div>
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
                {MOCK_PROJECTS.map((project) => (
                  <SidebarProjectCard
                    key={project.id}
                    project={project}
                    isSelected={selectedId === project.id}
                    onSelect={() => setSelectedId(project.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Main Content Area */}
          <div className="flex-1">
            {/* Header with project name, tabs, and view toggle inline */}
            <div className="flex items-center gap-4 mb-4">
              {!sidebarExpanded && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSidebarExpanded(true)}
                  className="px-2 flex-shrink-0"
                >
                  <List className="w-3 h-3 mr-1" />
                  <span className="text-sm font-medium">{selectedProject?.title}</span>
                </Button>
              )}

              {/* Orange Pill Navigation - ALWAYS CENTERED */}
              <div className="flex-1 flex justify-center">
                <PillNavigation
                  items={tabItems}
                  activeSection={activeTab}
                  onSectionClick={(id) => setActiveTab(id as typeof activeTab)}
                  colorVariant="orange"
                  size="small"
                  showIcons={true}
                  showText={true}
                  hasSubmenus={false}
                />
              </div>

              {/* View Toggle - INLINE to right of pill nav */}
              {activeTab === "tasks" && (
                <div className="flex gap-1 p-1 bg-black/30 rounded-lg border border-white/10 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("board")}
                    className={cn("px-3", viewMode === "board" && "bg-cyan-500/20 text-cyan-400")}
                    aria-label="Board view"
                    aria-pressed={viewMode === "board"}
                  >
                    <LayoutGrid className="w-4 h-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setViewMode("table")}
                    className={cn("px-3", viewMode === "table" && "bg-cyan-500/20 text-cyan-400")}
                    aria-label="Table view"
                    aria-pressed={viewMode === "table"}
                  >
                    <TableIcon className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
              )}
            </div>

            {/* Tab Content - Full Width, NO extra spacing */}
            <div>
              {activeTab === "tasks" && (viewMode === "board" ? <KanbanBoardView /> : <TaskTableView />)}
              {activeTab === "docs" && <EmbeddedDocumentBrowser doc={selectedDoc} onDocSelect={setSelectedDoc} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Sidebar Project Card - mini card style with StatPills
const SidebarProjectCard = ({
  project,
  isSelected,
  onSelect,
}: {
  project: (typeof MOCK_PROJECTS)[0];
  isSelected: boolean;
  onSelect: () => void;
}) => {
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
      className={cn("p-2", getBackgroundClass())}
    >
      <div className="space-y-2">
        {/* Title */}
        <div className="flex items-center justify-between">
          <h4
            className={cn(
              "font-medium text-sm line-clamp-1",
              isSelected ? "text-purple-700 dark:text-purple-300" : "text-gray-700 dark:text-gray-300",
            )}
          >
            {project.title}
          </h4>
          {project.pinned && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-500 text-white text-[9px] font-bold rounded-full"
              aria-label="Pinned"
            >
              <Pin className="w-2.5 h-2.5" aria-hidden="true" />
            </div>
          )}
        </div>

        {/* Status Pills - horizontal layout with icons */}
        <div className="flex items-center gap-1.5">
          <StatPill color="pink" value={project.taskCounts.todo} size="sm" icon={<ListTodo className="w-3 h-3" />} />
          <StatPill
            color="blue"
            value={project.taskCounts.doing + project.taskCounts.review}
            size="sm"
            icon={<Activity className="w-3 h-3" />}
          />
          <StatPill
            color="green"
            value={project.taskCounts.done}
            size="sm"
            icon={<CheckCircle2 className="w-3 h-3" />}
          />
        </div>
      </div>
    </SelectableCard>
  );
};

// Project Card using SelectableCard primitive
const ProjectCardExample = ({
  project,
  isSelected,
  onSelect,
}: {
  project: (typeof MOCK_PROJECTS)[0];
  isSelected: boolean;
  onSelect: () => void;
}) => {
  // Custom gradients for pinned vs selected vs default
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
      blur="xl"
      className={cn("w-72 min-h-[180px] flex flex-col shrink-0", getBackgroundClass())}
    >
      {/* Main content */}
      <div className="flex-1 p-3 pb-2">
        {/* Title */}
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
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-pink-300 dark:border-pink-500/50 dark:shadow-[0_0_10px_rgba(236,72,153,0.5)]"
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
              <div className="flex-1 flex items-center justify-center border-l border-pink-300 dark:border-pink-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {project.taskCounts.todo}
                </span>
              </div>
            </div>
          </div>

          {/* Doing pill */}
          <div className="relative flex-1">
            <div
              className={cn(
                "absolute inset-0 bg-blue-600 rounded-full blur-md",
                isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
              )}
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)]"
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
              <div className="flex-1 flex items-center justify-center border-l border-blue-300 dark:border-blue-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {project.taskCounts.doing + project.taskCounts.review}
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
            />
            <div
              className={cn(
                "relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
                isSelected
                  ? "bg-white/70 dark:bg-zinc-900/90 border-green-300 dark:border-green-500/50 dark:shadow-[0_0_10px_rgba(34,197,94,0.5)]"
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
              <div className="flex-1 flex items-center justify-center border-l border-green-300 dark:border-green-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {project.taskCounts.done}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar with action icons */}
      <div className="flex items-center justify-between px-3 py-2 mt-auto border-t border-gray-200/30 dark:border-gray-700/20">
        {/* Pinned indicator with icon */}
        {project.pinned ? (
          <div className="flex items-center gap-1 px-2 py-0.5 bg-purple-500 text-white text-[10px] font-bold rounded-full shadow-lg shadow-purple-500/30">
            <Pin className="w-2.5 h-2.5" />
            <span>PINNED</span>
          </div>
        ) : (
          <div />
        )}

        {/* Action icons */}
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 rounded-md hover:bg-red-500/10 text-gray-500 hover:text-red-500 transition-colors"
                  aria-label="Delete project"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete project</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    project.pinned
                      ? "bg-purple-500/10 text-purple-500"
                      : "hover:bg-purple-500/10 text-gray-500 hover:text-purple-500",
                  )}
                  aria-label={project.pinned ? "Unpin project" : "Pin project"}
                >
                  <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{project.pinned ? "Unpin project" : "Pin project"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 rounded-md hover:bg-cyan-500/10 text-gray-500 hover:text-cyan-500 transition-colors"
                  aria-label="Duplicate project"
                >
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Duplicate project</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </SelectableCard>
  );
};

// Kanban Board - NO BACKGROUNDS, wrapped in DndProvider
const KanbanBoardView = () => {
  const columns = [
    { status: "todo" as const, title: "Todo", color: "text-pink-500", glow: "bg-pink-500" },
    { status: "doing" as const, title: "Doing", color: "text-blue-500", glow: "bg-blue-500" },
    { status: "review" as const, title: "Review", color: "text-purple-500", glow: "bg-purple-500" },
    { status: "done" as const, title: "Done", color: "text-green-500", glow: "bg-green-500" },
  ];

  const getTasksByStatus = (status: (typeof columns)[0]["status"]) => {
    return MOCK_TASKS.filter((t) => t.status === status);
  };

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 min-h-[500px]">
        {columns.map(({ status, title, color, glow }) => (
          <div key={status} className="flex flex-col">
            {/* Column Header - transparent */}
            <div className="text-center py-3 relative">
              <h3 className={cn("font-mono text-sm font-medium", color)}>{title}</h3>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{getTasksByStatus(status).length}</div>
              <div
                className={cn("absolute bottom-0 left-[15%] right-[15%] w-[70%] mx-auto h-[1px]", glow, "shadow-md")}
              />
            </div>

            {/* Tasks */}
            <div className="flex-1 p-2 space-y-2">
              {getTasksByStatus(status).map((task, idx) => (
                <TaskCardExample key={task.id} task={task} index={idx} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </DndProvider>
  );
};

// Task Card using DraggableCard primitive with actions
const TaskCardExample = ({ task, index }: { task: (typeof MOCK_TASKS)[0]; index: number }) => {
  const getPriorityColor = (priority: string) => {
    if (priority === "high") return { color: "bg-red-500", glow: "shadow-[0_0_10px_rgba(239,68,68,0.3)]" };
    if (priority === "medium") return { color: "bg-yellow-500", glow: "shadow-[0_0_10px_rgba(234,179,8,0.3)]" };
    return { color: "bg-green-500", glow: "shadow-[0_0_10px_rgba(34,197,94,0.3)]" };
  };

  const priorityStyle = getPriorityColor(task.priority);

  return (
    <div className="relative group">
      <DraggableCard itemType="task" itemId={task.id} index={index} size="none" className="min-h-[140px]">
        {/* Priority indicator on left edge */}
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg opacity-80 group-hover:w-[4px] group-hover:opacity-100 transition-all duration-300",
            priorityStyle.color,
            priorityStyle.glow,
          )}
        />

        {/* Content */}
        <div className="flex flex-col h-full p-3">
          {/* Header with feature tag and actions */}
          <div className="flex items-center gap-2 mb-2 pl-1.5">
            {task.feature && (
              <div className="px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 backdrop-blur-md bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 shadow-sm">
                <Tag className="w-3 h-3" />
                {task.feature}
              </div>
            )}

            {/* Action buttons - matching TaskCard.tsx pattern */}
            <div className="ml-auto flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 rounded hover:bg-cyan-500/10 text-gray-500 hover:text-cyan-500 transition-colors"
                      aria-label="Edit task"
                    >
                      <Edit className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Edit task</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 rounded hover:bg-red-500/10 text-gray-500 hover:text-red-500 transition-colors"
                      aria-label="Delete task"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Delete task</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Title */}
          <h4 className="text-xs font-medium text-gray-900 dark:text-white mb-2 pl-1.5 line-clamp-2">{task.title}</h4>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Footer with assignee and priority */}
          <div className="flex items-center justify-between mt-auto pt-2 pl-1.5 pr-3">
            {/* Assignee card-style - matching TaskCard.tsx */}
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/50 dark:bg-black/30 border border-gray-200 dark:border-gray-700 text-xs">
              <User className="w-3 h-3 text-gray-500 dark:text-gray-400" />
              <span className="text-gray-700 dark:text-gray-300">{task.assignee}</span>
            </div>

            {/* Priority dot */}
            <div className={cn("w-2 h-2 rounded-full", priorityStyle.color)} />
          </div>
        </div>
      </DraggableCard>
    </div>
  );
};

// Task Table View - matching real TableView
const TaskTableView = () => {
  return (
    <div className="w-full">
      <div className="overflow-x-auto scrollbar-hide">
        <table className="w-full">
          <thead>
            <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
              <th className="w-1" />
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">Title</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-40">Feature</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-36">
                Assignee
              </th>
            </tr>
          </thead>
          <tbody>
            {MOCK_TASKS.map((task, index) => {
              const getPriorityColor = (priority: string) => {
                if (priority === "high") return { color: "bg-red-500", glow: "shadow-[0_0_10px_rgba(239,68,68,0.3)]" };
                if (priority === "medium")
                  return { color: "bg-yellow-500", glow: "shadow-[0_0_10px_rgba(234,179,8,0.3)]" };
                return { color: "bg-green-500", glow: "shadow-[0_0_10px_rgba(34,197,94,0.3)]" };
              };

              const priorityStyle = getPriorityColor(task.priority);

              return (
                <tr
                  key={task.id}
                  className={cn(
                    "group transition-all duration-200",
                    index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
                    "hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20",
                    "border-b border-gray-200 dark:border-gray-800",
                  )}
                >
                  {/* Priority indicator */}
                  <td className="w-1 p-0">
                    <div className={cn("w-1 h-full", priorityStyle.color, priorityStyle.glow)} />
                  </td>

                  {/* Title */}
                  <td className="px-4 py-2">
                    <span className="font-medium text-sm text-gray-900 dark:text-white">{task.title}</span>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-2 w-32">
                    <span
                      className={cn(
                        "px-2 py-1 text-xs rounded-md font-medium inline-block",
                        task.status === "todo" && "bg-pink-500/10 text-pink-600 dark:text-pink-400",
                        task.status === "doing" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                        task.status === "review" && "bg-purple-500/10 text-purple-600 dark:text-purple-400",
                        task.status === "done" && "bg-green-500/10 text-green-600 dark:text-green-400",
                      )}
                    >
                      {task.status}
                    </span>
                  </td>

                  {/* Feature */}
                  <td className="px-4 py-2 w-40">
                    <div className="flex items-center gap-1">
                      {task.feature && (
                        <>
                          <Tag className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                          <span className="text-sm text-gray-700 dark:text-gray-300">{task.feature}</span>
                        </>
                      )}
                    </div>
                  </td>

                  {/* Assignee - card style like real component */}
                  <td className="px-4 py-2 w-36">
                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/70 dark:bg-black/40 border border-gray-300 dark:border-gray-600 backdrop-blur-sm">
                      <User className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                      <span className="text-xs text-gray-700 dark:text-gray-300">{task.assignee}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Embedded Document Browser
const EmbeddedDocumentBrowser = ({
  doc,
  onDocSelect,
}: {
  doc: (typeof MOCK_DOCUMENTS)[0];
  onDocSelect: (doc: (typeof MOCK_DOCUMENTS)[0]) => void;
}) => {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredDocs = MOCK_DOCUMENTS.filter((d) => d.title.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div className="flex h-[600px] gap-6">
      {/* Left Sidebar */}
      <div className="w-64 flex flex-col space-y-4">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          <h3 className="text-lg font-semibold text-gray-800 dark:text-white">Documents</h3>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            aria-label="Search documents"
          />
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">{MOCK_DOCUMENTS.length} documents</p>

        <div className="flex-1 space-y-1">
          {filteredDocs.map((d) => {
            const isActive = d.id === doc.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onDocSelect(d)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-lg transition-all duration-200",
                  isActive
                    ? "bg-cyan-500/10 dark:bg-cyan-400/10 text-cyan-700 dark:text-cyan-300 border-l-2 border-cyan-500"
                    : "text-gray-600 dark:text-gray-400 hover:bg-white/5 dark:hover:bg-white/5 border-l-2 border-transparent",
                )}
              >
                <div className="font-medium text-sm line-clamp-1">{d.title}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{d.type}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right Content */}
      <div className="flex-1 overflow-y-auto">
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">{doc.title}</h2>
        <div className="text-gray-600 dark:text-gray-400 space-y-4">
          <p>
            Document type:{" "}
            <span className="px-2 py-1 text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded">
              {doc.type}
            </span>
          </p>
          <p>This area shows the full document content with rich formatting and embedded media.</p>
        </div>
      </div>
    </div>
  );
};
