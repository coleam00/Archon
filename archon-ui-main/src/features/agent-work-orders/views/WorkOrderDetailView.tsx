/**
 * WorkOrderDetailView Component
 *
 * Uses style guide components for agent work order visualization.
 * Matches the pattern from /features/style-guide/layouts/AgentWorkOrderExample.tsx
 */

import { AnimatePresence, motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";
import { WorkflowStepButton } from "@/features/style-guide/layouts/components/WorkflowStepButton";
import { StepHistoryCard } from "@/features/style-guide/layouts/components/StepHistoryCard";
import { RealTimeStats } from "../components/RealTimeStats";
import { WorkOrderLogsPanel } from "../components/WorkOrderLogsPanel";
import { useStepHistory, useWorkOrder } from "../hooks/useAgentWorkOrderQueries";
import { useRepository } from "../hooks/useRepositoryQueries";

const COMMAND_NAMES: Record<string, string> = {
	"create-branch": "Create Branch",
	planning: "Planning",
	execute: "Execute",
	commit: "Commit",
	"create-pr": "Create PR",
};

export function WorkOrderDetailView() {
	const { workOrderId } = useParams<{ workOrderId: string }>();
	const navigate = useNavigate();
	const [showDetails, setShowDetails] = useState(false);
	const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

	const { data: workOrder, isLoading: isLoadingWorkOrder, isError: isErrorWorkOrder } = useWorkOrder(workOrderId);
	const { data: repository, isLoading: isLoadingRepo } = useRepository(workOrder?.repository_id);
	const { data: stepHistory, isLoading: isLoadingSteps } = useStepHistory(workOrderId);

	const toggleStepExpansion = (stepId: string) => {
		setExpandedSteps((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(stepId)) {
				newSet.delete(stepId);
			} else {
				newSet.add(stepId);
			}
			return newSet;
		});
	};

	if (isLoadingWorkOrder || isLoadingRepo) {
		return (
			<div className="container mx-auto px-4 py-8">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-gray-800 rounded w-1/3" />
					<div className="h-40 bg-gray-800 rounded" />
					<div className="h-60 bg-gray-800 rounded" />
				</div>
			</div>
		);
	}

	if (isErrorWorkOrder || !workOrder) {
		return (
			<div className="container mx-auto px-4 py-8">
				<div className="text-center py-12">
					<p className="text-red-600 dark:text-red-400 mb-4">Failed to load work order</p>
					<Button onClick={() => navigate("/agent-work-orders")}>Back to List</Button>
				</div>
			</div>
		);
	}

	const repoName = repository?.repository_display_name || repository?.repository_name || "Unknown Repository";
	const timeAgo = formatDistanceToNow(new Date(workOrder.created_at), { addSuffix: true });

	// Build workflow steps from selected_commands
	const workflowSteps = workOrder.selected_commands.map((cmd, index) => {
		const stepInHistory = stepHistory?.steps?.find((s) => s.step === cmd);
		let status: "completed" | "in_progress" | "pending" = "pending";

		if (stepInHistory) {
			status = stepInHistory.success ? "completed" : "in_progress";
		} else if (workOrder.current_phase === cmd) {
			status = "in_progress";
		}

		return {
			id: `step-${index}`,
			name: COMMAND_NAMES[cmd] || cmd,
			status,
			command: cmd,
		};
	});

	return (
		<div className="space-y-6 pb-8">
			{/* Title */}
			<div>
				<h1 className="text-2xl font-bold text-gray-900 dark:text-white">{repoName}</h1>
				<p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Created {timeAgo}</p>
			</div>

			{/* Workflow Progress Bar with Style Guide Components */}
			<Card blur="md" transparency="light" edgePosition="top" edgeColor="cyan" size="lg" className="overflow-visible">
				<div className="flex items-center justify-between mb-6">
					<h3 className="text-lg font-semibold text-gray-900 dark:text-white">{workOrder.user_request}</h3>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setShowDetails(!showDetails)}
						className="text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10"
						aria-label={showDetails ? "Hide details" : "Show details"}
					>
						{showDetails ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
						Details
					</Button>
				</div>

				{/* Workflow Step Buttons */}
				<div className="flex items-center justify-center gap-0">
					{workflowSteps.map((step, index) => (
						<div key={step.id} className="flex items-center">
							<WorkflowStepButton
								isCompleted={step.status === "completed"}
								isActive={step.status === "in_progress"}
								stepName={step.name}
								color="cyan"
								size={50}
							/>

							{/* Connecting Line */}
							{index < workflowSteps.length - 1 && (
								<div className="relative flex-shrink-0" style={{ width: "80px", height: "50px" }}>
									<div
										className={
											step.status === "completed"
												? "absolute top-1/2 left-0 right-0 h-[2px] border-t-2 border-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
												: "absolute top-1/2 left-0 right-0 h-[2px] border-t-2 border-gray-600 dark:border-gray-700"
										}
									/>
								</div>
							)}
						</div>
					))}
				</div>

				{/* Collapsible Details Section */}
				<AnimatePresence>
					{showDetails && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: "auto", opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={{
								height: { duration: 0.3, ease: [0.04, 0.62, 0.23, 0.98] },
								opacity: { duration: 0.2, ease: "easeInOut" },
							}}
							style={{ overflow: "hidden" }}
							className="mt-6"
						>
							<motion.div
								initial={{ y: -20 }}
								animate={{ y: 0 }}
								exit={{ y: -20 }}
								transition={{ duration: 0.2, ease: "easeOut" }}
								className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 border-t border-gray-200/50 dark:border-gray-700/30"
							>
								{/* Left Column - Details */}
								<div className="space-y-4">
									<div>
										<h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
											Details
										</h4>
										<div className="space-y-3 text-sm">
											<div>
												<p className="text-gray-500 dark:text-gray-400">Status</p>
												<p className="text-gray-900 dark:text-white font-medium">{workOrder.status}</p>
											</div>
											<div>
												<p className="text-gray-500 dark:text-gray-400">Sandbox Type</p>
												<p className="text-gray-900 dark:text-white font-medium">{workOrder.sandbox_type}</p>
											</div>
											<div>
												<p className="text-gray-500 dark:text-gray-400">Work Order ID</p>
												<p className="text-gray-900 dark:text-white font-mono text-xs">{workOrder.agent_work_order_id}</p>
											</div>
											{workOrder.github_issue_number && (
												<div>
													<p className="text-gray-500 dark:text-gray-400">GitHub Issue</p>
													<p className="text-gray-900 dark:text-white font-medium">#{workOrder.github_issue_number}</p>
												</div>
											)}
										</div>
									</div>
								</div>

								{/* Right Column - Statistics */}
								<div className="space-y-4">
									<div>
										<h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
											Statistics
										</h4>
										<div className="space-y-3 text-sm">
											<div>
												<p className="text-gray-500 dark:text-gray-400">Steps Completed</p>
												<p className="text-gray-900 dark:text-white font-medium">
													{stepHistory?.steps?.filter((s) => s.success).length || 0} /{" "}
													{stepHistory?.steps?.length || workOrder.selected_commands.length}
												</p>
											</div>
											<div>
												<p className="text-gray-500 dark:text-gray-400">Repository</p>
												<p className="text-gray-900 dark:text-white font-medium">{repoName}</p>
											</div>
											{workOrder.git_branch_name && (
												<div>
													<p className="text-gray-500 dark:text-gray-400">Branch</p>
													<p className="text-gray-900 dark:text-white font-mono text-xs">{workOrder.git_branch_name}</p>
												</div>
											)}
											{workOrder.github_pull_request_url && (
												<div>
													<p className="text-gray-500 dark:text-gray-400">Pull Request</p>
													<a
														href={workOrder.github_pull_request_url}
														target="_blank"
														rel="noopener noreferrer"
														className="text-cyan-600 dark:text-cyan-400 hover:underline text-xs"
													>
														View PR
													</a>
												</div>
											)}
										</div>
									</div>
								</div>
							</motion.div>
						</motion.div>
					)}
				</AnimatePresence>
			</Card>

			{/* Error Message if Failed */}
			{workOrder.error_message && (
				<Card blur="md" transparency="light" edgePosition="left" edgeColor="orange" size="lg">
					<div className="flex items-start gap-3">
						<div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
							<span className="text-red-600 dark:text-red-400 text-xl">!</span>
						</div>
						<div>
							<h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-1">Execution Failed</h3>
							<p className="text-sm text-gray-700 dark:text-gray-300">{workOrder.error_message}</p>
						</div>
					</div>
				</Card>
			)}

			{/* Real-Time Stats */}
			<RealTimeStats workOrderId={workOrderId} />

			{/* Step History */}
			{stepHistory?.steps && stepHistory.steps.length > 0 && (
				<div className="space-y-4">
					<h2 className="text-xl font-semibold text-gray-900 dark:text-white">Step History</h2>
					{stepHistory.steps.map((step) => {
						const output = step.error_message
							? `ERROR: ${step.error_message}`
							: step.output || "No output";

						return (
							<StepHistoryCard
								key={step.step}
								step={{
									id: step.step,
									stepName: COMMAND_NAMES[step.step] || step.step,
									timestamp: formatDistanceToNow(new Date(step.timestamp), { addSuffix: true }),
									output: output,
									session: step.session_id ? `Session: ${step.session_id}` : `Duration: ${step.duration_seconds.toFixed(2)}s`,
									collapsible: true,
									isHumanInLoop: false,
								}}
								isExpanded={expandedSteps.has(step.step)}
								onToggle={() => toggleStepExpansion(step.step)}
							/>
						);
					})}
				</div>
			)}

			{/* Real-Time Logs */}
			<WorkOrderLogsPanel workOrderId={workOrderId} />
		</div>
	);
}
