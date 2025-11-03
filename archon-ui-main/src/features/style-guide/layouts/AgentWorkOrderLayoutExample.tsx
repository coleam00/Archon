import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Eye,
  GitBranch,
  LayoutGrid,
  List,
  Pin,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Checkbox } from "@/features/ui/primitives/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/features/ui/primitives/dialog";
import { Input } from "@/features/ui/primitives/input";
import { StatPill } from "@/features/ui/primitives/pill";
import { PillNavigation, type PillNavigationItem } from "@/features/ui/primitives/pill-navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { SelectableCard } from "@/features/ui/primitives/selectable-card";
import { cn } from "@/features/ui/primitives/styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/features/ui/primitives/tooltip";
import { AgentWorkOrderExample } from "./AgentWorkOrderExample";
import { RealTimeStatsExample } from "./components/RealTimeStatsExample";

const MOCK_REPOSITORIES = [
  {
    id: "1",
    name: "archon-frontend",
    url: "https://github.com/coleam00/archon-ui",
    pinned: true,
    workOrderCounts: { pending: 1, create_branch: 1, plan: 0, execute: 0, commit: 1, create_pr: 0 },
  },
  {
    id: "2",
    name: "archon-backend",
    url: "https://github.com/coleam00/archon-backend",
    pinned: false,
    workOrderCounts: { pending: 0, create_branch: 0, plan: 1, execute: 1, commit: 0, create_pr: 0 },
  },
  {
    id: "3",
    name: "archon-docs",
    url: "https://github.com/coleam00/archon-docs",
    pinned: false,
    workOrderCounts: { pending: 0, create_branch: 0, plan: 0, execute: 0, commit: 0, create_pr: 1 },
  },
];

type WorkOrderStatus = "pending" | "create_branch" | "plan" | "execute" | "commit" | "create_pr";

interface WorkOrder {
  id: string;
  repositoryId: string;
  repositoryName: string;
  request: string;
  status: WorkOrderStatus;
  steps: {
    createBranch: boolean;
    plan: boolean;
    execute: boolean;
    commit: boolean;
    createPR: boolean;
  };
  createdAt: string;
}

const MOCK_WORK_ORDERS: WorkOrder[] = [
  {
    id: "wo-1dc27d9e",
    repositoryId: "1",
    repositoryName: "archon-frontend",
    request: "Add dark mode toggle to settings page",
    status: "pending",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-15T10:30:00Z",
  },
  {
    id: "wo-2af8b3c1",
    repositoryId: "1",
    repositoryName: "archon-frontend",
    request: "Refactor navigation component to use new design system",
    status: "create_branch",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-15T09:15:00Z",
  },
  {
    id: "wo-4e372af3",
    repositoryId: "2",
    repositoryName: "archon-backend",
    request: "Implement caching layer for API responses",
    status: "plan",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-14T16:45:00Z",
  },
  {
    id: "wo-8b91f2d6",
    repositoryId: "2",
    repositoryName: "archon-backend",
    request: "Add rate limiting to authentication endpoints",
    status: "execute",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-14T14:20:00Z",
  },
  {
    id: "wo-5c7d4a89",
    repositoryId: "1",
    repositoryName: "archon-frontend",
    request: "Fix responsive layout issues on mobile devices",
    status: "commit",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-13T11:00:00Z",
  },
  {
    id: "wo-9f3e1b5a",
    repositoryId: "3",
    repositoryName: "archon-docs",
    request: "Update API documentation with new endpoints",
    status: "create_pr",
    steps: { createBranch: true, plan: true, execute: true, commit: true, createPR: true },
    createdAt: "2024-01-12T08:30:00Z",
  },
];

export const AgentWorkOrderLayoutExample = () => {
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("1");
  const [layoutMode, setLayoutMode] = useState<"horizontal" | "sidebar">("sidebar");
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [showNewWorkOrderModal, setShowNewWorkOrderModal] = useState(false);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>(MOCK_WORK_ORDERS);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [showDetailView, setShowDetailView] = useState(false);
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const selectedRepository = MOCK_REPOSITORIES.find((r) => r.id === selectedRepositoryId);
  const selectedWorkOrder = workOrders.find((wo) => wo.id === selectedWorkOrderId);

  // If showing detail view, render the detail component
  if (showDetailView && selectedWorkOrder) {
    return (
      <div className="space-y-4">
        {/* Breadcrumb navigation */}
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setShowDetailView(false)}
            className="text-cyan-600 dark:text-cyan-400 hover:underline"
          >
            Work Orders
          </button>
          <span className="text-gray-400 dark:text-gray-600">/</span>
          <button
            type="button"
            onClick={() => setShowDetailView(false)}
            className="text-cyan-600 dark:text-cyan-400 hover:underline"
          >
            {selectedWorkOrder.repositoryName}
          </button>
          <span className="text-gray-400 dark:text-gray-600">/</span>
          <span className="text-gray-900 dark:text-white">{selectedWorkOrder.id}</span>
        </div>
        <AgentWorkOrderExample />
      </div>
    );
  }

  // Tab items for navigation
  const tabItems: PillNavigationItem[] = [
    { id: "all", label: "All Work Orders", icon: <GitBranch className="w-4 h-4" /> },
  ];

  // Add selected repository as a tab if one is selected (always show, even when viewing all)
  if (selectedRepository) {
    tabItems.push({
      id: selectedRepository.id,
      label: selectedRepository.name,
      icon: <GitBranch className="w-4 h-4" />,
    });
  }

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div className="flex items-center justify-between gap-4">
        {/* Title */}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agent Work Orders</h1>

        {/* Search Bar */}
        <div className="relative flex-1 max-w-md">
          <Search
            className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <Input
            type="text"
            placeholder="Search repositories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            aria-label="Search repositories"
          />
        </div>

        {/* View Toggle - Sidebar is default/primary */}
        <div className="flex gap-1 p-1 bg-black/30 dark:bg-white/10 rounded-lg border border-white/10 dark:border-gray-700">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayoutMode("sidebar")}
            className={cn(
              "px-3",
              layoutMode === "sidebar" && "bg-purple-500/20 dark:bg-purple-500/30 text-purple-400 dark:text-purple-300",
            )}
            aria-label="Switch to sidebar layout"
            aria-pressed={layoutMode === "sidebar"}
          >
            <List className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLayoutMode("horizontal")}
            className={cn(
              "px-3",
              layoutMode === "horizontal" &&
                "bg-purple-500/20 dark:bg-purple-500/30 text-purple-400 dark:text-purple-300",
            )}
            aria-label="Switch to horizontal layout"
            aria-pressed={layoutMode === "horizontal"}
          >
            <LayoutGrid className="w-4 h-4" aria-hidden="true" />
          </Button>
        </div>

        {/* New Repo Button */}
        <Button variant="cyan" onClick={() => setShowAddRepoModal(true)} aria-label="Add new repository">
          <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
          New Repo
        </Button>
      </div>

      {/* Add Repository Modal */}
      <AddRepositoryModal open={showAddRepoModal} onOpenChange={setShowAddRepoModal} />

      {layoutMode === "horizontal" ? (
        <>
          {/* Horizontal Repository Cards - ONLY cards scroll, not whole page */}
          <div className="w-full max-w-full">
            <div className="overflow-x-auto overflow-y-visible py-8 -mx-6 px-6 scrollbar-hide">
              <div className="flex gap-4 min-w-max">
                {MOCK_REPOSITORIES.map((repository) => (
                  <RepositoryCard
                    key={repository.id}
                    repository={repository}
                    isSelected={selectedRepositoryId === repository.id}
                    onSelect={() => {
                      setSelectedRepositoryId(repository.id);
                      setActiveTab(repository.id);
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Orange Pill Navigation centered */}
          <div className="flex items-center justify-center">
            <PillNavigation
              items={tabItems}
              activeSection={activeTab}
              onSectionClick={(id) => {
                setActiveTab(id);
                if (id !== "all") {
                  setSelectedRepositoryId(id);
                }
              }}
              colorVariant="orange"
              size="small"
              showIcons={true}
              showText={true}
              hasSubmenus={false}
            />
          </div>

          {/* Work Orders Table */}
          <WorkOrdersTableView
            workOrders={workOrders}
            selectedRepositoryId={activeTab === "all" ? undefined : selectedRepositoryId}
            onStartWorkOrder={(id) => {
              setWorkOrders((prev) =>
                prev.map((wo) => (wo.id === id ? { ...wo, status: "create_branch" as WorkOrderStatus } : wo)),
              );
            }}
            onViewDetails={(id) => {
              setSelectedWorkOrderId(id);
              setShowDetailView(true);
            }}
            showNewWorkOrderModal={showNewWorkOrderModal}
            onNewWorkOrderModalChange={setShowNewWorkOrderModal}
          />
        </>
      ) : (
        /* Sidebar Mode */
        <div className="flex gap-6">
          {/* Left Sidebar - Collapsible Repository List */}
          {sidebarExpanded && (
            <div className="w-56 flex-shrink-0 space-y-2">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white">Repositories</h3>
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
                {MOCK_REPOSITORIES.map((repository) => (
                  <SidebarRepositoryCard
                    key={repository.id}
                    repository={repository}
                    isSelected={selectedRepositoryId === repository.id}
                    onSelect={() => {
                      setSelectedRepositoryId(repository.id);
                      setActiveTab(repository.id);
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Main Content Area */}
          <div className="flex-1 min-w-0">
            {/* Header with repository name, tabs, and actions inline */}
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
                  <span className="text-sm font-medium">{selectedRepository?.name}</span>
                </Button>
              )}

              {/* Orange Pill Navigation - ALWAYS CENTERED */}
              <div className="flex-1 flex justify-center">
                <PillNavigation
                  items={tabItems}
                  activeSection={activeTab}
                  onSectionClick={(id) => {
                    setActiveTab(id);
                    if (id !== "all") {
                      setSelectedRepositoryId(id);
                    }
                  }}
                  colorVariant="orange"
                  size="small"
                  showIcons={true}
                  showText={true}
                  hasSubmenus={false}
                />
              </div>

              {/* Spacer for symmetry */}
              <div className="flex-shrink-0 w-[80px]" />
            </div>

            {/* Work Orders Table - Full Width, NO extra spacing */}
            <WorkOrdersTableView
              workOrders={workOrders}
              selectedRepositoryId={activeTab === "all" ? undefined : selectedRepositoryId}
              onStartWorkOrder={(id) => {
                setWorkOrders((prev) =>
                  prev.map((wo) => (wo.id === id ? { ...wo, status: "create_branch" as WorkOrderStatus } : wo)),
                );
              }}
              onViewDetails={(id) => {
                setSelectedWorkOrderId(id);
                setShowDetailView(true);
              }}
              showNewWorkOrderModal={showNewWorkOrderModal}
              onNewWorkOrderModalChange={setShowNewWorkOrderModal}
            />
          </div>
        </div>
      )}
    </div>
  );
};

// Repository Card using SelectableCard primitive
const RepositoryCard = ({
  repository,
  isSelected,
  onSelect,
}: {
  repository: (typeof MOCK_REPOSITORIES)[0];
  isSelected: boolean;
  onSelect: () => void;
}) => {
  // Custom gradients for pinned vs selected vs default
  const getBackgroundClass = () => {
    if (repository.pinned)
      return "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10";
    if (isSelected)
      return "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20";
    return "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30";
  };

  // Calculate aggregated counts
  const totalWorkOrders =
    repository.workOrderCounts.pending +
    repository.workOrderCounts.create_branch +
    repository.workOrderCounts.plan +
    repository.workOrderCounts.execute +
    repository.workOrderCounts.commit +
    repository.workOrderCounts.create_pr;

  const inProgressCount =
    repository.workOrderCounts.pending +
    repository.workOrderCounts.create_branch +
    repository.workOrderCounts.plan +
    repository.workOrderCounts.execute +
    repository.workOrderCounts.commit;

  const completedCount = repository.workOrderCounts.create_pr;

  return (
    <SelectableCard
      isSelected={isSelected}
      isPinned={repository.pinned}
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
                : repository.pinned
                  ? "text-purple-700 dark:text-purple-300"
                  : "text-gray-500 dark:text-gray-400",
            )}
          >
            {repository.name}
          </h3>
        </div>

        {/* Work order count pills - 3 aggregated statuses */}
        <div className="flex items-stretch gap-2 w-full">
          {/* Total pill */}
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
                <Clock
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
                  Total
                </span>
              </div>
              <div className="flex-1 flex items-center justify-center border-l border-pink-300 dark:border-pink-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-pink-600 dark:text-pink-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {totalWorkOrders}
                </span>
              </div>
            </div>
          </div>

          {/* In Progress pill */}
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
                  Active
                </span>
              </div>
              <div className="flex-1 flex items-center justify-center border-l border-blue-300 dark:border-blue-500/30">
                <span
                  className={cn(
                    "text-lg font-bold",
                    isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
                  )}
                >
                  {inProgressCount}
                </span>
              </div>
            </div>
          </div>

          {/* Completed pill */}
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
                  {completedCount}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar with action icons */}
      <div className="flex items-center justify-between px-3 py-2 mt-auto border-t border-gray-200/30 dark:border-gray-700/20">
        {/* Pinned indicator with icon */}
        {repository.pinned ? (
          <div className="flex items-center gap-1 px-2 py-0.5 bg-purple-500 text-white text-[10px] font-bold rounded-full shadow-lg shadow-purple-500/30">
            <Pin className="w-2.5 h-2.5" aria-hidden="true" />
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
                  className="p-1.5 rounded-md hover:bg-red-500/10 dark:hover:bg-red-500/20 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  aria-label="Delete repository"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete repository</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "p-1.5 rounded-md transition-colors",
                    repository.pinned
                      ? "bg-purple-500/10 dark:bg-purple-500/20 text-purple-500 dark:text-purple-400"
                      : "hover:bg-purple-500/10 dark:hover:bg-purple-500/20 text-gray-500 dark:text-gray-400 hover:text-purple-500 dark:hover:text-purple-400",
                  )}
                  aria-label={repository.pinned ? "Unpin repository" : "Pin repository"}
                >
                  <Pin className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{repository.pinned ? "Unpin repository" : "Pin repository"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 rounded-md hover:bg-cyan-500/10 dark:hover:bg-cyan-500/20 text-gray-500 dark:text-gray-400 hover:text-cyan-500 dark:hover:text-cyan-400 transition-colors"
                  aria-label="Duplicate repository"
                >
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Duplicate repository</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </SelectableCard>
  );
};

// Sidebar Repository Card - mini card style with StatPills
const SidebarRepositoryCard = ({
  repository,
  isSelected,
  onSelect,
}: {
  repository: (typeof MOCK_REPOSITORIES)[0];
  isSelected: boolean;
  onSelect: () => void;
}) => {
  const getBackgroundClass = () => {
    if (repository.pinned)
      return "bg-gradient-to-b from-purple-100/80 via-purple-50/30 to-purple-100/50 dark:from-purple-900/30 dark:via-purple-900/20 dark:to-purple-900/10";
    if (isSelected)
      return "bg-gradient-to-b from-white/70 via-purple-50/20 to-white/50 dark:from-white/5 dark:via-purple-900/5 dark:to-black/20";
    return "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30";
  };

  // Calculate aggregated counts
  const totalWorkOrders =
    repository.workOrderCounts.pending +
    repository.workOrderCounts.create_branch +
    repository.workOrderCounts.plan +
    repository.workOrderCounts.execute +
    repository.workOrderCounts.commit +
    repository.workOrderCounts.create_pr;

  const inProgressCount =
    repository.workOrderCounts.pending +
    repository.workOrderCounts.create_branch +
    repository.workOrderCounts.plan +
    repository.workOrderCounts.execute +
    repository.workOrderCounts.commit;

  const completedCount = repository.workOrderCounts.create_pr;

  return (
    <SelectableCard
      isSelected={isSelected}
      isPinned={repository.pinned}
      showAuroraGlow={isSelected}
      onSelect={onSelect}
      size="none"
      blur="md"
      className={cn("p-2 w-56", getBackgroundClass())}
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
            {repository.name}
          </h4>
          {repository.pinned && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 bg-purple-500 text-white text-[9px] font-bold rounded-full"
              aria-label="Pinned"
            >
              <Pin className="w-2.5 h-2.5" aria-hidden="true" />
            </div>
          )}
        </div>

        {/* Status Pills - all 3 on one row */}
        <div className="flex items-center gap-1.5">
          <StatPill color="pink" value={totalWorkOrders} size="sm" icon={<Clock className="w-3 h-3" />} />
          <StatPill color="blue" value={inProgressCount} size="sm" icon={<Activity className="w-3 h-3" />} />
          <StatPill color="green" value={completedCount} size="sm" icon={<CheckCircle2 className="w-3 h-3" />} />
        </div>
      </div>
    </SelectableCard>
  );
};

// Work Orders Table View
const WorkOrdersTableView = ({
  workOrders,
  selectedRepositoryId,
  onStartWorkOrder,
  onViewDetails,
  showNewWorkOrderModal,
  onNewWorkOrderModalChange,
}: {
  workOrders: WorkOrder[];
  selectedRepositoryId?: string;
  onStartWorkOrder: (id: string) => void;
  onViewDetails: (id: string) => void;
  showNewWorkOrderModal: boolean;
  onNewWorkOrderModalChange: (open: boolean) => void;
}) => {
  // Filter work orders based on selected repository
  const filteredWorkOrders = selectedRepositoryId
    ? workOrders.filter((wo) => wo.repositoryId === selectedRepositoryId)
    : workOrders;

  return (
    <div className="w-full">
      {/* Header with New Work Order button */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Work Orders</h3>
        <NewWorkOrderModal open={showNewWorkOrderModal} onOpenChange={onNewWorkOrderModalChange} />
      </div>

      <div className="overflow-x-auto scrollbar-hide">
        <table className="w-full">
          <thead>
            <tr className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 border-b-2 border-gray-200 dark:border-gray-700">
              <th className="w-12" aria-label="Status indicator" />
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">WO ID</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-40">
                Repository
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300">
                Request Summary
              </th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredWorkOrders.map((workOrder, index) => (
              <WorkOrderRow
                key={workOrder.id}
                workOrder={workOrder}
                index={index}
                onStart={() => onStartWorkOrder(workOrder.id)}
                onViewDetails={() => onViewDetails(workOrder.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Work Order Row with status-based styling and expandable real-time stats
const WorkOrderRow = ({
  workOrder,
  index,
  onStart,
  onViewDetails,
}: {
  workOrder: WorkOrder;
  index: number;
  onStart: () => void;
  onViewDetails: () => void;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Status colors - STATIC lookup with all properties
  const statusColors: Record<
    WorkOrderStatus,
    {
      color: "pink" | "cyan" | "blue" | "orange" | "purple" | "green";
      edge: string;
      glow: string;
      label: string;
      stepNumber: number;
    }
  > = {
    pending: {
      color: "pink",
      edge: "bg-pink-500",
      glow: "rgba(236,72,153,0.5)",
      label: "Pending",
      stepNumber: 0,
    },
    create_branch: {
      color: "cyan",
      edge: "bg-cyan-500",
      glow: "rgba(34,211,238,0.5)",
      label: "+ Branch",
      stepNumber: 1,
    },
    plan: {
      color: "blue",
      edge: "bg-blue-500",
      glow: "rgba(59,130,246,0.5)",
      label: "Planning",
      stepNumber: 2,
    },
    execute: {
      color: "orange",
      edge: "bg-orange-500",
      glow: "rgba(249,115,22,0.5)",
      label: "Executing",
      stepNumber: 3,
    },
    commit: {
      color: "purple",
      edge: "bg-purple-500",
      glow: "rgba(168,85,247,0.5)",
      label: "Commit",
      stepNumber: 4,
    },
    create_pr: {
      color: "green",
      edge: "bg-green-500",
      glow: "rgba(34,197,94,0.5)",
      label: "Create PR",
      stepNumber: 5,
    },
  };

  const colors = statusColors[workOrder.status];
  const canExpand = workOrder.status !== "pending";

  const handleStart = () => {
    setIsExpanded(true); // Auto-expand when started
    onStart();
  };

  return (
    <>
      <tr
        className={cn(
          "group transition-all duration-200",
          index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
          "hover:bg-gradient-to-r hover:from-cyan-50/70 hover:to-purple-50/70 dark:hover:from-cyan-900/20 dark:hover:to-purple-900/20",
          "border-b border-gray-200 dark:border-gray-800",
        )}
      >
        {/* Status indicator - glowing circle with optional collapse button */}
        <td className="px-3 py-2 w-12">
          <div className="flex items-center justify-center gap-1">
            {canExpand && (
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                aria-label={isExpanded ? "Collapse details" : "Expand details"}
                aria-expanded={isExpanded}
              >
                {isExpanded ? (
                  <ChevronUp className="w-3 h-3 text-gray-600 dark:text-gray-400" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-gray-600 dark:text-gray-400" aria-hidden="true" />
                )}
              </button>
            )}
            <div className={cn("w-3 h-3 rounded-full", colors.edge)} style={{ boxShadow: `0 0 8px ${colors.glow}` }} />
          </div>
        </td>

        {/* Work Order ID */}
        <td className="px-4 py-2">
          <span className="font-mono text-sm text-gray-700 dark:text-gray-300">{workOrder.id}</span>
        </td>

        {/* Repository */}
        <td className="px-4 py-2 w-40">
          <span className="text-sm text-gray-900 dark:text-white">{workOrder.repositoryName}</span>
        </td>

        {/* Request Summary */}
        <td className="px-4 py-2">
          <p className="text-sm text-gray-900 dark:text-white line-clamp-2">{workOrder.request}</p>
        </td>

        {/* Status Badge - using StatPill */}
        <td className="px-4 py-2 w-32">
          <StatPill color={colors.color} value={colors.label} size="sm" />
        </td>

        {/* Actions */}
        <td className="px-4 py-2 w-32">
          {workOrder.status === "pending" ? (
            <Button
              onClick={handleStart}
              size="xs"
              variant="green"
              className="w-full text-xs"
              aria-label="Start work order"
            >
              <Play className="w-3 h-3 mr-1" aria-hidden="true" />
              Start
            </Button>
          ) : (
            <Button
              onClick={onViewDetails}
              size="xs"
              variant="blue"
              className="w-full text-xs"
              aria-label="View work order details"
            >
              <Eye className="w-3 h-3 mr-1" aria-hidden="true" />
              Details
            </Button>
          )}
        </td>
      </tr>

      {/* Expanded row with real-time stats */}
      {isExpanded && canExpand && (
        <tr
          className={cn(
            index % 2 === 0 ? "bg-white/50 dark:bg-black/50" : "bg-gray-50/80 dark:bg-gray-900/30",
            "border-b border-gray-200 dark:border-gray-800",
          )}
        >
          <td colSpan={6} className="px-4 py-4">
            <RealTimeStatsExample status={workOrder.status} stepNumber={colors.stepNumber} />
          </td>
        </tr>
      )}
    </>
  );
};

// Add Repository Modal
const AddRepositoryModal = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = () => {
    // Validation
    if (!repositoryName.trim()) {
      setError("Repository name is required");
      return;
    }
    if (!repositoryUrl.trim()) {
      setError("Repository URL is required");
      return;
    }
    if (!repositoryUrl.startsWith("https://")) {
      setError("Repository URL must start with https://");
      return;
    }

    // Success - add to repositories (mock)
    console.log("Adding repository:", { repositoryName, repositoryUrl });
    setRepositoryName("");
    setRepositoryUrl("");
    setError("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Repository</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
          {/* Repository Name */}
          <div>
            <label
              htmlFor="repository-name"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              Repository Name
            </label>
            <Input
              id="repository-name"
              type="text"
              placeholder="archon-frontend"
              value={repositoryName}
              onChange={(e) => {
                setRepositoryName(e.target.value);
                setError("");
              }}
              aria-label="Repository name"
            />
          </div>

          {/* Repository URL */}
          <div>
            <label htmlFor="repository-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Repository URL
            </label>
            <Input
              id="repository-url"
              type="url"
              placeholder="https://github.com/..."
              value={repositoryUrl}
              onChange={(e) => {
                setRepositoryUrl(e.target.value);
                setError("");
              }}
              aria-label="Repository URL"
            />
          </div>

          {/* Error Message */}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} aria-label="Cancel">
              Cancel
            </Button>
            <Button onClick={handleSubmit} className="bg-cyan-500 hover:bg-cyan-600" aria-label="Add repository">
              Add Repository
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// New Work Order Modal
const NewWorkOrderModal = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [requestText, setRequestText] = useState("");
  const [stepsState, setStepsState] = useState({
    createBranch: true,
    plan: true,
    execute: true,
    commit: false,
    createPR: false,
  });
  const [error, setError] = useState("");

  // Dependency logic
  const canEnableCommit = stepsState.execute;
  const canEnableCreatePR = stepsState.execute;

  const handleSubmit = () => {
    // Validation
    if (!selectedRepoId) {
      setError("Please select a repository");
      return;
    }
    if (!requestText.trim()) {
      setError("Request is required");
      return;
    }
    if (
      !stepsState.createBranch &&
      !stepsState.plan &&
      !stepsState.execute &&
      !stepsState.commit &&
      !stepsState.createPR
    ) {
      setError("At least one step must be selected");
      return;
    }

    // Success - create work order (mock)
    console.log("Creating work order:", { selectedRepoId, requestText, steps: stepsState });
    setSelectedRepoId("");
    setRequestText("");
    setStepsState({
      createBranch: true,
      plan: true,
      execute: true,
      commit: false,
      createPR: false,
    });
    setError("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="cyan" aria-label="Create new work order">
          <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
          New Work Order
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Work Order</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
          {/* Repository Select */}
          <div>
            <label
              htmlFor="repository-select"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
            >
              Repository
            </label>
            <Select
              value={selectedRepoId}
              onValueChange={(value) => {
                setSelectedRepoId(value);
                setError("");
              }}
            >
              <SelectTrigger id="repository-select" aria-label="Select repository">
                <SelectValue placeholder="Select repository..." />
              </SelectTrigger>
              <SelectContent>
                {MOCK_REPOSITORIES.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Request Input */}
          <div>
            <label htmlFor="request-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Request
            </label>
            <Input
              id="request-input"
              type="text"
              placeholder="Describe the work to be done..."
              value={requestText}
              onChange={(e) => {
                setRequestText(e.target.value);
                setError("");
              }}
              aria-label="Work order request"
            />
          </div>

          {/* Step Toggles */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Workflow Steps</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="step-create-branch"
                  checked={stepsState.createBranch}
                  onCheckedChange={(checked) => {
                    setStepsState({ ...stepsState, createBranch: checked === true });
                    setError("");
                  }}
                  aria-label="Create branch step"
                />
                <label htmlFor="step-create-branch" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  Create Branch
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="step-plan"
                  checked={stepsState.plan}
                  onCheckedChange={(checked) => {
                    setStepsState({ ...stepsState, plan: checked === true });
                    setError("");
                  }}
                  aria-label="Plan step"
                />
                <label htmlFor="step-plan" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  Plan
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="step-execute"
                  checked={stepsState.execute}
                  onCheckedChange={(checked) => {
                    const newExecute = checked === true;
                    setStepsState({
                      ...stepsState,
                      execute: newExecute,
                      // Auto-disable dependent steps if execute is disabled
                      commit: newExecute ? stepsState.commit : false,
                      createPR: newExecute ? stepsState.createPR : false,
                    });
                    setError("");
                  }}
                  aria-label="Execute step"
                />
                <label htmlFor="step-execute" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                  Execute
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="step-commit"
                  checked={stepsState.commit}
                  onCheckedChange={(checked) => {
                    setStepsState({ ...stepsState, commit: checked === true });
                    setError("");
                  }}
                  disabled={!canEnableCommit}
                  className={cn(!canEnableCommit && "opacity-50 cursor-not-allowed")}
                  aria-label="Commit step"
                  aria-disabled={!canEnableCommit}
                />
                <label
                  htmlFor="step-commit"
                  className={cn(
                    "text-sm cursor-pointer",
                    canEnableCommit
                      ? "text-gray-700 dark:text-gray-300"
                      : "text-gray-400 dark:text-gray-600 cursor-not-allowed",
                  )}
                >
                  Commit
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="step-create-pr"
                  checked={stepsState.createPR}
                  onCheckedChange={(checked) => {
                    setStepsState({ ...stepsState, createPR: checked === true });
                    setError("");
                  }}
                  disabled={!canEnableCreatePR}
                  className={cn(!canEnableCreatePR && "opacity-50 cursor-not-allowed")}
                  aria-label="Create PR step"
                  aria-disabled={!canEnableCreatePR}
                />
                <label
                  htmlFor="step-create-pr"
                  className={cn(
                    "text-sm cursor-pointer",
                    canEnableCreatePR
                      ? "text-gray-700 dark:text-gray-300"
                      : "text-gray-400 dark:text-gray-600 cursor-not-allowed",
                  )}
                >
                  Create PR
                </label>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} aria-label="Cancel">
              Cancel
            </Button>
            <Button onClick={handleSubmit} className="bg-cyan-500 hover:bg-cyan-600" aria-label="Create work order">
              Create Work Order
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
