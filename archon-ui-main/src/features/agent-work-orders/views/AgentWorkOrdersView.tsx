/**
 * AgentWorkOrdersView Component
 *
 * Main view for repository-based agent work orders.
 * Mirrors ProjectsView pattern: Repository selection → Kanban board (no tabs)
 */

import { motion } from "framer-motion";
import { Activity, AlertCircle, CheckCircle2, Clock, Github, List, Pin } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useStaggeredEntrance } from "../../../hooks/useStaggeredEntrance";
import { isOptimistic } from "../../shared/utils/optimistic";
import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
import { Button, SelectableCard } from "../../ui/primitives";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { StatPill } from "../../ui/primitives/pill";
import { cn } from "../../ui/primitives/styles";
import { AddRepositoryModal } from "../components/AddRepositoryModal";
import { RepositoryHeader } from "../components/RepositoryHeader";
import { RepositoryList } from "../components/RepositoryList";
import {
	repositoryKeys,
	useDeleteRepository,
	useRepositories,
	useUpdateRepository,
} from "../hooks/useRepositoryQueries";
import { useRepositoryWorkOrders } from "../hooks/useAgentWorkOrderQueries";
import type { GitHubRepository } from "../types/repository";
import { WorkOrderKanbanView } from "./WorkOrderKanbanView";

interface AgentWorkOrdersViewProps {
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

export function AgentWorkOrdersView({ className = "", "data-id": dataId }: AgentWorkOrdersViewProps) {
	const { repositoryId } = useParams();
	const navigate = useNavigate();

	// State management
	const [selectedRepository, setSelectedRepository] = useState<GitHubRepository | null>(null);
	const [layoutMode, setLayoutMode] = useState<"horizontal" | "sidebar">("horizontal");
	const [sidebarExpanded, setSidebarExpanded] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [isAddRepoModalOpen, setIsAddRepoModalOpen] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [repositoryToDelete, setRepositoryToDelete] = useState<{
		id: string;
		name: string;
	} | null>(null);

	// React Query hooks
	const { data: repositories = [], isLoading: isLoadingRepositories, error: repositoriesError } = useRepositories();
	const { data: workOrders = [] } = useRepositoryWorkOrders(selectedRepository?.id);

	// Mutations
	const updateRepositoryMutation = useUpdateRepository();
	const deleteRepositoryMutation = useDeleteRepository();

	// Calculate work order counts for each repository
	const workOrderCounts = useMemo(() => {
		const counts: Record<string, { todo: number; in_progress: number; review: number; done: number }> = {};

		repositories.forEach((repo) => {
			counts[repo.id] = { todo: 0, in_progress: 0, review: 0, done: 0 };
		});

		// For now, we only have counts for the selected repository
		if (selectedRepository) {
			counts[selectedRepository.id] = workOrders.reduce(
				(acc, wo) => {
					if (wo.status === "todo") acc.todo++;
					else if (wo.status === "in_progress") acc.in_progress++;
					else if (wo.status === "review") acc.review++;
					else if (wo.status === "done") acc.done++;
					return acc;
				},
				{ todo: 0, in_progress: 0, review: 0, done: 0 },
			);
		}

		return counts;
	}, [repositories, selectedRepository, workOrders]);

	// Sort and filter repositories
	const sortedRepositories = useMemo(() => {
		const filtered = repositories.filter((repo) =>
			(repo.repository_display_name || repo.repository_name).toLowerCase().includes(searchQuery.toLowerCase()),
		);

		return filtered.sort((a, b) => {
			if (a.pinned && !b.pinned) return -1;
			if (!a.pinned && b.pinned) return 1;
			return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
		});
	}, [repositories, searchQuery]);

	// Handle repository selection
	const handleRepositorySelect = useCallback(
		(repository: GitHubRepository) => {
			if (selectedRepository?.id === repository.id) return;

			setSelectedRepository(repository);
			navigate(`/agent-work-orders/${repository.id}`, { replace: true });
		},
		[selectedRepository?.id, navigate],
	);

	// Auto-select repository based on URL or default to first
	useEffect(() => {
		if (!sortedRepositories.length) return;

		if (repositoryId) {
			const repository = sortedRepositories.find((r) => r.id === repositoryId);
			if (repository) {
				setSelectedRepository(repository);
				return;
			}
		}

		if (!selectedRepository || !sortedRepositories.find((r) => r.id === selectedRepository.id)) {
			const defaultRepository = sortedRepositories[0];
			setSelectedRepository(defaultRepository);
			navigate(`/agent-work-orders/${defaultRepository.id}`, { replace: true });
		}
	}, [sortedRepositories, repositoryId, selectedRepository, navigate]);

	// Handle pin toggle
	const handlePinRepository = async (e: React.MouseEvent, repositoryId: string) => {
		e.stopPropagation();
		const repository = repositories.find((r) => r.id === repositoryId);
		if (!repository) return;

		updateRepositoryMutation.mutate({
			id: repositoryId,
			updates: { pinned: !repository.pinned },
		});
	};

	// Handle delete repository
	const handleDeleteRepository = (e: React.MouseEvent, repositoryId: string, name: string) => {
		e.stopPropagation();
		setRepositoryToDelete({ id: repositoryId, name });
		setShowDeleteConfirm(true);
	};

	const confirmDeleteRepository = () => {
		if (!repositoryToDelete) return;

		deleteRepositoryMutation.mutate(repositoryToDelete.id, {
			onSuccess: () => {
				setShowDeleteConfirm(false);
				setRepositoryToDelete(null);

				if (selectedRepository?.id === repositoryToDelete.id) {
					const remainingRepositories = repositories.filter((r) => r.id !== repositoryToDelete.id);
					if (remainingRepositories.length > 0) {
						const nextRepository = remainingRepositories[0];
						setSelectedRepository(nextRepository);
						navigate(`/agent-work-orders/${nextRepository.id}`, { replace: true });
					} else {
						setSelectedRepository(null);
						navigate("/agent-work-orders", { replace: true });
					}
				}
			},
		});
	};

	const cancelDeleteRepository = () => {
		setShowDeleteConfirm(false);
		setRepositoryToDelete(null);
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
			<RepositoryHeader
				onAddRepository={() => setIsAddRepoModalOpen(true)}
				layoutMode={layoutMode}
				onLayoutModeChange={setLayoutMode}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
			/>

			{layoutMode === "horizontal" ? (
				<>
					<RepositoryList
						repositories={sortedRepositories}
						selectedRepository={selectedRepository}
						workOrderCounts={workOrderCounts}
						isLoading={isLoadingRepositories}
						error={repositoriesError as Error | null}
						onRepositorySelect={handleRepositorySelect}
						onPinRepository={handlePinRepository}
						onDeleteRepository={handleDeleteRepository}
						onRetry={() => window.location.reload()}
					/>

					{selectedRepository && (
						<div className="px-6 md:px-8">
							<WorkOrderKanbanView
								repositoryId={selectedRepository.id}
								repositoryName={selectedRepository.repository_display_name || selectedRepository.repository_name}
							/>
						</div>
					)}
				</>
			) : (
				/* Sidebar Mode */
				<div className="flex gap-6 px-6 md:px-8">
					{/* Left Sidebar - Collapsible Repository List */}
					{sidebarExpanded && (
						<div className="w-64 flex-shrink-0 space-y-2">
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
								{sortedRepositories.map((repository) => (
									<SidebarRepositoryCard
										key={repository.id}
										repository={repository}
										isSelected={selectedRepository?.id === repository.id}
										workOrderCounts={
											workOrderCounts[repository.id] || { todo: 0, in_progress: 0, review: 0, done: 0 }
										}
										onSelect={() => handleRepositorySelect(repository)}
									/>
								))}
							</div>
						</div>
					)}

					{/* Main Content Area */}
					<div className="flex-1 min-w-0">
						{selectedRepository && (
							<>
								{/* Header with repository name and expand button */}
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
											<span className="text-sm font-medium">
												{selectedRepository.repository_display_name || selectedRepository.repository_name}
											</span>
										</Button>
									)}
								</div>

								{/* Kanban Board */}
								<WorkOrderKanbanView
									repositoryId={selectedRepository.id}
									repositoryName={selectedRepository.repository_display_name || selectedRepository.repository_name}
								/>
							</>
						)}
					</div>
				</div>
			)}

			{/* Add Repository Modal */}
			<AddRepositoryModal
				open={isAddRepoModalOpen}
				onOpenChange={setIsAddRepoModalOpen}
				onSuccess={() => setIsAddRepoModalOpen(false)}
			/>

			{/* Delete Confirmation Modal */}
			<DeleteConfirmModal
				open={showDeleteConfirm}
				itemName={repositoryToDelete?.name || ""}
				type="repository"
				onConfirm={confirmDeleteRepository}
				onCancel={cancelDeleteRepository}
				isDeleting={deleteRepositoryMutation.isPending}
			/>
		</motion.div>
	);
}

// Sidebar Repository Card - compact variant with StatPills
interface SidebarRepositoryCardProps {
	repository: GitHubRepository;
	isSelected: boolean;
	workOrderCounts: {
		todo: number;
		in_progress: number;
		review: number;
		done: number;
	};
	onSelect: () => void;
}

const SidebarRepositoryCard: React.FC<SidebarRepositoryCardProps> = ({
	repository,
	isSelected,
	workOrderCounts,
	onSelect,
}) => {
	const optimistic = isOptimistic(repository);
	const displayName = repository.repository_display_name || repository.repository_name;

	const getBackgroundClass = () => {
		if (repository.pinned)
			return "bg-gradient-to-b from-blue-100/80 via-blue-50/30 to-blue-100/50 dark:from-blue-900/30 dark:via-blue-900/20 dark:to-blue-900/10";
		if (isSelected)
			return "bg-gradient-to-b from-white/70 via-blue-50/20 to-white/50 dark:from-white/5 dark:via-blue-900/5 dark:to-black/20";
		return "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30";
	};

	return (
		<SelectableCard
			isSelected={isSelected}
			isPinned={repository.pinned}
			showAuroraGlow={isSelected}
			onSelect={onSelect}
			size="none"
			blur="md"
			className={cn("p-2", getBackgroundClass(), optimistic && "opacity-80 ring-1 ring-cyan-400/30")}
		>
			<div className="space-y-2">
				{/* Title with GitHub icon */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1.5 flex-1 min-w-0">
						<Github
							className={cn(
								"w-3 h-3 flex-shrink-0",
								isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400",
							)}
						/>
						<h4
							className={cn(
								"font-medium text-sm line-clamp-1",
								isSelected ? "text-blue-700 dark:text-blue-300" : "text-gray-700 dark:text-gray-300",
							)}
						>
							{displayName}
						</h4>
					</div>
					<div className="flex items-center gap-1">
						{repository.pinned && (
							<div
								className="flex items-center gap-1 px-1.5 py-0.5 bg-blue-500 dark:bg-blue-600 text-white text-[9px] font-bold rounded-full"
								aria-label="Pinned"
							>
								<Pin className="w-2.5 h-2.5" aria-hidden="true" />
							</div>
						)}
						<OptimisticIndicator isOptimistic={optimistic} />
					</div>
				</div>

				{/* Status Pills - 4 separate pills in 2x2 grid */}
				<div className="grid grid-cols-2 gap-1">
					<StatPill color="gray" value={workOrderCounts.todo} size="sm" icon={<Clock className="w-3 h-3" />} />
					<StatPill color="blue" value={workOrderCounts.in_progress} size="sm" icon={<Activity className="w-3 h-3" />} />
					<StatPill color="orange" value={workOrderCounts.review} size="sm" icon={<AlertCircle className="w-3 h-3" />} />
					<StatPill color="green" value={workOrderCounts.done} size="sm" icon={<CheckCircle2 className="w-3 h-3" />} />
				</div>
			</div>
		</SelectableCard>
	);
};
