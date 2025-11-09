/**
 * Agent Work Orders View
 *
 * Main view for agent work orders with repository management and layout switching.
 * Supports horizontal and sidebar layout modes.
 */

import { ChevronLeft, ChevronRight, GitBranch, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useShallow } from "zustand/shallow";
import { Button } from "@/features/ui/primitives/button";
import { Input } from "@/features/ui/primitives/input";
import { PillNavigation, type PillNavigationItem } from "@/features/ui/primitives/pill-navigation";
import { cn } from "@/features/ui/primitives/styles";
import { AddRepositoryModal } from "../components/AddRepositoryModal";
import { CreateWorkOrderModal } from "../components/CreateWorkOrderModal";
import { EditRepositoryModal } from "../components/EditRepositoryModal";
import { RepositoryCard } from "../components/RepositoryCard";
import { SidebarRepositoryCard } from "../components/SidebarRepositoryCard";
import { WorkOrderTable } from "../components/WorkOrderTable";
import { useStartWorkOrder, useWorkOrders } from "../hooks/useAgentWorkOrderQueries";
import { useDeleteRepository, useRepositories } from "../hooks/useRepositoryQueries";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";

export function AgentWorkOrdersView() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Zustand UI Preferences - Group related state with useShallow
  const { layoutMode, sidebarExpanded } = useAgentWorkOrdersStore(
    useShallow((s) => ({
      layoutMode: s.layoutMode,
      sidebarExpanded: s.sidebarExpanded,
    })),
  );

  // Zustand UI Preference Actions - Functions are stable, select individually
  const setLayoutMode = useAgentWorkOrdersStore((s) => s.setLayoutMode);
  const setSidebarExpanded = useAgentWorkOrdersStore((s) => s.setSidebarExpanded);

  // Zustand Modals State - Group with useShallow
  const { showAddRepoModal, showEditRepoModal, showCreateWorkOrderModal, editingRepository } = useAgentWorkOrdersStore(
    useShallow((s) => ({
      showAddRepoModal: s.showAddRepoModal,
      showEditRepoModal: s.showEditRepoModal,
      showCreateWorkOrderModal: s.showCreateWorkOrderModal,
      editingRepository: s.editingRepository,
    })),
  );

  // Zustand Modal Actions - Functions are stable, select individually
  const openAddRepoModal = useAgentWorkOrdersStore((s) => s.openAddRepoModal);
  const closeAddRepoModal = useAgentWorkOrdersStore((s) => s.closeAddRepoModal);
  const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);
  const closeEditRepoModal = useAgentWorkOrdersStore((s) => s.closeEditRepoModal);
  const openCreateWorkOrderModal = useAgentWorkOrdersStore((s) => s.openCreateWorkOrderModal);
  const closeCreateWorkOrderModal = useAgentWorkOrdersStore((s) => s.closeCreateWorkOrderModal);

  // Zustand Filters - Select individually
  const searchQuery = useAgentWorkOrdersStore((s) => s.searchQuery);
  const setSearchQuery = useAgentWorkOrdersStore((s) => s.setSearchQuery);

  // Use URL params as source of truth for selected repository (no Zustand state needed)
  const selectedRepositoryId = searchParams.get("repo") || undefined;

  // Fetch data
  const { data: repositories = [], isLoading: isLoadingRepos } = useRepositories();
  const { data: workOrders = [], isLoading: isLoadingWorkOrders } = useWorkOrders();
  const startWorkOrder = useStartWorkOrder();
  const deleteRepository = useDeleteRepository();

  // Helper function to select repository (updates URL only)
  const selectRepository = useCallback(
    (id: string | undefined) => {
      if (id) {
        setSearchParams({ repo: id });
      } else {
        setSearchParams({});
      }
    },
    [setSearchParams],
  );

  /**
   * Handle repository deletion
   */
  const handleDeleteRepository = useCallback(
    async (id: string) => {
      if (confirm("Are you sure you want to delete this repository configuration?")) {
        await deleteRepository.mutateAsync(id);
        // If this was the selected repository, clear selection
        if (selectedRepositoryId === id) {
          selectRepository(undefined);
        }
      }
    },
    [deleteRepository, selectedRepositoryId, selectRepository],
  );

  /**
   * Calculate work order stats for a repository
   */
  const getRepositoryStats = (repositoryId: string) => {
    const repoWorkOrders = workOrders.filter((wo) => {
      const repo = repositories.find((r) => r.id === repositoryId);
      return repo && wo.repository_url === repo.repository_url;
    });

    return {
      total: repoWorkOrders.length,
      active: repoWorkOrders.filter((wo) => wo.status === "running" || wo.status === "pending").length,
      done: repoWorkOrders.filter((wo) => wo.status === "completed").length,
    };
  };

  /**
   * Build tab items for PillNavigation
   */
  const tabItems: PillNavigationItem[] = [
    { id: "all", label: "All Work Orders", icon: <GitBranch className="w-4 h-4" aria-hidden="true" /> },
  ];

  if (selectedRepositoryId) {
    const selectedRepo = repositories.find((r) => r.id === selectedRepositoryId);
    if (selectedRepo) {
      tabItems.push({
        id: selectedRepositoryId,
        label: selectedRepo.display_name || selectedRepo.repository_url,
        icon: <GitBranch className="w-4 h-4" aria-hidden="true" />,
      });
    }
  }

  // Filter repositories by search query
  const filteredRepositories = repositories.filter((repo) => {
    const searchLower = searchQuery.toLowerCase();
    return (
      repo.display_name?.toLowerCase().includes(searchLower) ||
      repo.repository_url.toLowerCase().includes(searchLower) ||
      repo.owner?.toLowerCase().includes(searchLower)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Title */}
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agent Work Orders</h1>

        {/* Search Bar */}
        <div className="relative flex-1 min-w-0 max-w-md">
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

        {/* Layout Toggle */}
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
        <Button onClick={openAddRepoModal} variant="cyan" aria-label="Add new repository">
          <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
          New Repo
        </Button>
      </div>

      {/* Modals */}
      <AddRepositoryModal open={showAddRepoModal} onOpenChange={closeAddRepoModal} />
      <EditRepositoryModal open={showEditRepoModal} onOpenChange={closeEditRepoModal} />
      <CreateWorkOrderModal open={showCreateWorkOrderModal} onOpenChange={closeCreateWorkOrderModal} />

      {/* Horizontal Layout */}
      {layoutMode === "horizontal" && (
        <>
          {/* Repository cards in horizontal scroll */}
          <div className="w-full max-w-full">
            <div className="overflow-x-auto overflow-y-visible py-8 -mx-6 px-6 scrollbar-hide">
              <div className="flex gap-4 min-w-max">
                {filteredRepositories.length === 0 ? (
                  <div className="w-full text-center py-12">
                    <p className="text-gray-500 dark:text-gray-400">
                      {searchQuery ? "No repositories match your search" : "No repositories configured"}
                    </p>
                  </div>
                ) : (
                  filteredRepositories.map((repository) => (
                    <RepositoryCard
                      key={repository.id}
                      repository={repository}
                      isSelected={selectedRepositoryId === repository.id}
                      showAuroraGlow={selectedRepositoryId === repository.id}
                      onSelect={() => selectRepository(repository.id)}
                      onDelete={() => handleDeleteRepository(repository.id)}
                      stats={getRepositoryStats(repository.id)}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

          {/* PillNavigation centered */}
          <div className="flex items-center justify-center">
            <PillNavigation
              items={tabItems}
              activeSection={selectedRepositoryId || "all"}
              onSectionClick={(id) => {
                if (id === "all") {
                  selectRepository(undefined);
                } else {
                  selectRepository(id);
                }
              }}
            />
          </div>
        </>
      )}

      {/* Sidebar Layout */}
      {layoutMode === "sidebar" && (
        <div className="flex gap-4 min-w-0">
          {/* Collapsible Sidebar */}
          <div className={cn("shrink-0 transition-all duration-300 space-y-2", sidebarExpanded ? "w-56" : "w-12")}>
            {/* Collapse/Expand button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSidebarExpanded(!sidebarExpanded)}
              className="w-full justify-center"
              aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
              aria-expanded={sidebarExpanded}
            >
              {sidebarExpanded ? (
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              )}
            </Button>

            {/* Sidebar content */}
            {sidebarExpanded && (
              <div className="space-y-2 px-1">
                {filteredRepositories.length === 0 ? (
                  <div className="text-center py-8 px-2">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {searchQuery ? "No repositories match" : "No repositories"}
                    </p>
                  </div>
                ) : (
                  filteredRepositories.map((repository) => (
                    <SidebarRepositoryCard
                      key={repository.id}
                      repository={repository}
                      isSelected={selectedRepositoryId === repository.id}
                      isPinned={false}
                      showAuroraGlow={selectedRepositoryId === repository.id}
                      onSelect={() => selectRepository(repository.id)}
                      onDelete={() => handleDeleteRepository(repository.id)}
                      stats={getRepositoryStats(repository.id)}
                    />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Main content area */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* PillNavigation centered */}
            <div className="flex items-center justify-center">
              <PillNavigation
                items={tabItems}
                activeSection={selectedRepositoryId || "all"}
                onSectionClick={(id) => {
                  if (id === "all") {
                    selectRepository(undefined);
                  } else {
                    selectRepository(id);
                  }
                }}
              />
            </div>

            {/* Work Orders Table */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Work Orders</h3>
                <Button
                  onClick={() => openCreateWorkOrderModal(selectedRepositoryId)}
                  variant="cyan"
                  aria-label="Create new work order"
                >
                  <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
                  New Work Order
                </Button>
              </div>

              <WorkOrderTable
                workOrders={workOrders}
                selectedRepositoryId={selectedRepositoryId}
                onStartWorkOrder={(id) => startWorkOrder.mutate(id)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Horizontal layout work orders table (below repository cards) */}
      {layoutMode === "horizontal" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Work Orders</h3>
            <Button
              onClick={() => openCreateWorkOrderModal(selectedRepositoryId)}
              variant="cyan"
              aria-label="Create new work order"
            >
              <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
              New Work Order
            </Button>
          </div>

          <WorkOrderTable
            workOrders={workOrders}
            selectedRepositoryId={selectedRepositoryId}
            onStartWorkOrder={(id) => startWorkOrder.mutate(id)}
          />
        </div>
      )}

      {/* Loading state */}
      {(isLoadingRepos || isLoadingWorkOrders) && (
        <div className="flex items-center justify-center py-12">
          <p className="text-gray-500 dark:text-gray-400">Loading...</p>
        </div>
      )}
    </div>
  );
}
