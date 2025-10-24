import { motion } from "framer-motion";
import { AlertCircle, Loader2 } from "lucide-react";
import React from "react";
import { Button } from "../../ui/primitives";
import type { GitHubRepository } from "../types/repository";
import { RepositoryCard } from "./RepositoryCard";

interface RepositoryListProps {
	repositories: GitHubRepository[];
	selectedRepository: GitHubRepository | null;
	workOrderCounts: Record<string, { todo: number; in_progress: number; review: number; done: number }>;
	isLoading: boolean;
	error: Error | null;
	onRepositorySelect: (repository: GitHubRepository) => void;
	onPinRepository: (e: React.MouseEvent, repositoryId: string) => void;
	onDeleteRepository: (e: React.MouseEvent, repositoryId: string, name: string) => void;
	onRetry: () => void;
}

const itemVariants = {
	hidden: { opacity: 0, y: 20 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
	},
};

export const RepositoryList: React.FC<RepositoryListProps> = ({
	repositories,
	selectedRepository,
	workOrderCounts,
	isLoading,
	error,
	onRepositorySelect,
	onPinRepository,
	onDeleteRepository,
	onRetry,
}) => {
	// Sort repositories - pinned first, then by creation date (newest first)
	const sortedRepositories = React.useMemo(() => {
		return [...repositories].sort((a, b) => {
			// Pinned repositories always come first
			if (a.pinned && !b.pinned) return -1;
			if (!a.pinned && b.pinned) return 1;

			// Then sort by creation date (newest first)
			const timeA = Number.isFinite(Date.parse(a.created_at)) ? Date.parse(a.created_at) : 0;
			const timeB = Number.isFinite(Date.parse(b.created_at)) ? Date.parse(b.created_at) : 0;
			const byDate = timeB - timeA;
			return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
		});
	}, [repositories]);

	// Auto-scroll selected repository into view
	React.useEffect(() => {
		if (selectedRepository) {
			const element = document.getElementById(`repository-${selectedRepository.id}`);
			if (element) {
				element.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
			}
		}
	}, [selectedRepository]);

	if (isLoading) {
		return (
			<motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
				<div className="flex items-center justify-center py-12">
					<div className="text-center" aria-live="polite" aria-busy="true">
						<Loader2 className="w-8 h-8 text-blue-500 mx-auto mb-4 animate-spin" />
						<p className="text-gray-600 dark:text-gray-400">Loading repositories...</p>
					</div>
				</div>
			</motion.div>
		);
	}

	if (error) {
		return (
			<motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
				<div className="flex items-center justify-center py-12">
					<div className="text-center" role="alert" aria-live="assertive">
						<AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-4" />
						<p className="text-red-600 dark:text-red-400 mb-4">{error.message || "Failed to load repositories"}</p>
						<Button onClick={onRetry} variant="default">
							Try Again
						</Button>
					</div>
				</div>
			</motion.div>
		);
	}

	if (sortedRepositories.length === 0) {
		return (
			<motion.div initial="hidden" animate="visible" variants={itemVariants} className="mb-10">
				<div className="flex items-center justify-center py-12">
					<div className="text-center">
						<p className="text-gray-600 dark:text-gray-400 mb-4">
							No repositories yet. Add a GitHub repository to get started!
						</p>
					</div>
				</div>
			</motion.div>
		);
	}

	return (
		<motion.div initial="hidden" animate="visible" className="relative mb-10 w-full" variants={itemVariants}>
			<div className="overflow-x-auto overflow-y-visible pb-4 pt-2 pr-6 md:pr-8 scrollbar-thin">
				<ul className="flex gap-4 min-w-max pl-6 md:pl-8" aria-label="Repositories">
					{sortedRepositories.map((repository) => (
						<li key={repository.id} id={`repository-${repository.id}`}>
							<RepositoryCard
								repository={repository}
								isSelected={selectedRepository?.id === repository.id}
								workOrderCounts={
									workOrderCounts[repository.id] || { todo: 0, in_progress: 0, review: 0, done: 0 }
								}
								onSelect={() => onRepositorySelect(repository)}
								onPin={(e) => onPinRepository(e, repository.id)}
								onDelete={(e) => onDeleteRepository(e, repository.id, repository.repository_name)}
							/>
						</li>
					))}
				</ul>
			</div>
		</motion.div>
	);
};
