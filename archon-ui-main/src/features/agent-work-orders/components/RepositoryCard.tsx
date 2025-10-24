import { Activity, AlertCircle, CheckCircle2, Clock, Github } from "lucide-react";
import type React from "react";
import { isOptimistic } from "@/features/shared/utils/optimistic";
import { OptimisticIndicator } from "../../ui/primitives/OptimisticIndicator";
import { SelectableCard } from "../../ui/primitives/selectable-card";
import { cn } from "../../ui/primitives/styles";
import type { GitHubRepository } from "../types/repository";
import { RepositoryCardActions } from "./RepositoryCardActions";

interface RepositoryCardProps {
	repository: GitHubRepository;
	isSelected: boolean;
	workOrderCounts: {
		todo: number;
		in_progress: number;
		review: number;
		done: number;
	};
	onSelect: () => void;
	onPin: (e: React.MouseEvent) => void;
	onDelete: (e: React.MouseEvent) => void;
}

export const RepositoryCard: React.FC<RepositoryCardProps> = ({
	repository,
	isSelected,
	workOrderCounts,
	onSelect,
	onPin,
	onDelete,
}) => {
	const optimistic = isOptimistic(repository);
	const displayName = repository.repository_display_name || repository.repository_name;

	return (
		<SelectableCard
			isSelected={isSelected}
			isPinned={repository.pinned}
			showAuroraGlow={isSelected}
			onSelect={onSelect}
			blur="xl"
			transparency="light"
			size="none"
			className={cn(
				"w-72 min-h-[180px] flex flex-col shrink-0",
				repository.pinned
					? "bg-gradient-to-b from-blue-100/80 via-blue-50/30 to-blue-100/50 dark:from-blue-900/30 dark:via-blue-900/20 dark:to-blue-900/10"
					: isSelected
						? "bg-gradient-to-b from-white/70 via-blue-50/20 to-white/50 dark:from-white/5 dark:via-blue-900/5 dark:to-black/20"
						: "bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30",
				optimistic && "opacity-80 ring-1 ring-cyan-400/30",
			)}
		>
			{/* Main content area with padding */}
			<div className="flex-1 p-4 pb-2">
				{/* Title section with GitHub icon */}
				<div className="flex flex-col items-center justify-center mb-4 min-h-[48px]">
					<div className="flex items-center gap-2 mb-1">
						<Github
							className={cn(
								"w-5 h-5",
								isSelected
									? "text-blue-600 dark:text-blue-400"
									: repository.pinned
										? "text-blue-700 dark:text-blue-300"
										: "text-gray-500 dark:text-gray-400",
							)}
						/>
					</div>
					<h3
						className={cn(
							"font-medium text-center leading-tight line-clamp-2 transition-all duration-300",
							isSelected
								? "text-gray-900 dark:text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
								: repository.pinned
									? "text-blue-700 dark:text-blue-300"
									: "text-gray-500 dark:text-gray-400",
						)}
					>
						{displayName}
					</h3>
					<OptimisticIndicator isOptimistic={optimistic} className="mt-1" />
				</div>

				{/* Work order count pills */}
				<div className="flex flex-col sm:flex-row items-stretch gap-2 w-full">
					{/* To Do pill */}
					<div className="relative flex-1">
						<div
							className={cn(
								"absolute inset-0 bg-gray-600 rounded-full blur-md",
								isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
							)}
						></div>
						<div
							className={cn(
								"relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
								isSelected
									? "bg-white/70 dark:bg-zinc-900/90 border-gray-300 dark:border-gray-500/50 dark:shadow-[0_0_10px_rgba(156,163,175,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(156,163,175,0.7)]"
									: "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
							)}
						>
							<div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
								<Clock
									className={cn(
										"w-4 h-4",
										isSelected ? "text-gray-600 dark:text-gray-400" : "text-gray-500 dark:text-gray-600",
									)}
								/>
								<span
									className={cn(
										"text-[8px] font-medium",
										isSelected ? "text-gray-600 dark:text-gray-400" : "text-gray-500 dark:text-gray-600",
									)}
								>
									ToDo
								</span>
							</div>
							<div
								className={cn(
									"flex-1 flex items-center justify-center border-l",
									isSelected ? "border-gray-300 dark:border-gray-500/30" : "border-gray-300/50 dark:border-gray-700/50",
								)}
							>
								<span
									className={cn(
										"text-lg font-bold",
										isSelected ? "text-gray-600 dark:text-gray-400" : "text-gray-500 dark:text-gray-600",
									)}
								>
									{workOrderCounts.todo || 0}
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
						></div>
						<div
							className={cn(
								"relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
								isSelected
									? "bg-white/70 dark:bg-zinc-900/90 border-blue-300 dark:border-blue-500/50 dark:shadow-[0_0_10px_rgba(59,130,246,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(59,130,246,0.7)]"
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
							<div
								className={cn(
									"flex-1 flex items-center justify-center border-l",
									isSelected ? "border-blue-300 dark:border-blue-500/30" : "border-gray-300/50 dark:border-gray-700/50",
								)}
							>
								<span
									className={cn(
										"text-lg font-bold",
										isSelected ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-600",
									)}
								>
									{workOrderCounts.in_progress || 0}
								</span>
							</div>
						</div>
					</div>

					{/* Review pill */}
					<div className="relative flex-1">
						<div
							className={cn(
								"absolute inset-0 bg-orange-600 rounded-full blur-md",
								isSelected ? "opacity-30 dark:opacity-75" : "opacity-0",
							)}
						></div>
						<div
							className={cn(
								"relative flex items-center h-12 backdrop-blur-sm rounded-full border shadow-sm transition-all duration-300",
								isSelected
									? "bg-white/70 dark:bg-zinc-900/90 border-orange-300 dark:border-orange-500/50 dark:shadow-[0_0_10px_rgba(249,115,22,0.5)] hover:shadow-md dark:hover:shadow-[0_0_15px_rgba(249,115,22,0.7)]"
									: "bg-white/30 dark:bg-zinc-900/30 border-gray-300/50 dark:border-gray-700/50",
							)}
						>
							<div className="flex flex-col items-center justify-center px-2 min-w-[40px]">
								<AlertCircle
									className={cn(
										"w-4 h-4",
										isSelected ? "text-orange-600 dark:text-orange-400" : "text-gray-500 dark:text-gray-600",
									)}
								/>
								<span
									className={cn(
										"text-[8px] font-medium",
										isSelected ? "text-orange-600 dark:text-orange-400" : "text-gray-500 dark:text-gray-600",
									)}
								>
									Review
								</span>
							</div>
							<div
								className={cn(
									"flex-1 flex items-center justify-center border-l",
									isSelected
										? "border-orange-300 dark:border-orange-500/30"
										: "border-gray-300/50 dark:border-gray-700/50",
								)}
							>
								<span
									className={cn(
										"text-lg font-bold",
										isSelected ? "text-orange-600 dark:text-orange-400" : "text-gray-500 dark:text-gray-600",
									)}
								>
									{workOrderCounts.review || 0}
								</span>
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Bottom bar with pinned indicator and actions */}
			<div className="flex items-center justify-between px-3 py-2 mt-auto border-t border-gray-200/30 dark:border-gray-700/20">
				{/* Pinned indicator badge */}
				{repository.pinned ? (
					<div className="px-2 py-0.5 bg-blue-500 dark:bg-blue-600 text-white text-[10px] font-bold rounded-full shadow-lg shadow-blue-500/30">
						DEFAULT
					</div>
				) : (
					<div></div>
				)}

				{/* Action Buttons */}
				<RepositoryCardActions
					repositoryId={repository.id}
					repositoryName={displayName}
					isPinned={repository.pinned}
					onPin={onPin}
					onDelete={onDelete}
				/>
			</div>
		</SelectableCard>
	);
};
