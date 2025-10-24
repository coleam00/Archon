/**
 * CreateWorkOrderDialog Component
 *
 * Modal dialog for creating new agent work orders.
 * Repository is pre-selected, so we only need user request and options.
 */

import { Loader2 } from "lucide-react";
import { useState, useId } from "react";
import { Button } from "../../ui/primitives/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/primitives/dialog";
import { Input } from "../../ui/primitives/input";
import { cn } from "../../ui/primitives/styles";
import { useCreateWorkOrder } from "../hooks/useAgentWorkOrderQueries";
import type { CreateAgentWorkOrderRequest, WorkflowStep, SandboxType } from "../types";

interface CreateWorkOrderDialogProps {
	repositoryId: string;
	repositoryName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const DEFAULT_COMMANDS: WorkflowStep[] = ["create-branch", "planning", "execute", "commit", "create-pr"];

const COMMAND_LABELS: Record<WorkflowStep, string> = {
	"create-branch": "Create Branch",
	planning: "Planning",
	execute: "Execute",
	commit: "Commit",
	"create-pr": "Create PR",
	"prp-review": "PRP Review",
};

export const CreateWorkOrderDialog = ({ repositoryId, repositoryName, open, onOpenChange }: CreateWorkOrderDialogProps) => {
	const userRequestId = useId();
	const issueNumberId = useId();

	const [formData, setFormData] = useState({
		user_request: "",
		selected_commands: DEFAULT_COMMANDS,
		sandbox_type: "git_worktree" as SandboxType,
		github_issue_number: "",
	});

	const createMutation = useCreateWorkOrder();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!formData.user_request.trim()) return;

		const request: CreateAgentWorkOrderRequest = {
			repository_id: repositoryId,
			user_request: formData.user_request,
			selected_commands: formData.selected_commands,
			sandbox_type: formData.sandbox_type,
			github_issue_number: formData.github_issue_number || null,
		};

		createMutation.mutate(request, {
			onSuccess: () => {
				setFormData({
					user_request: "",
					selected_commands: DEFAULT_COMMANDS,
					sandbox_type: "git_worktree",
					github_issue_number: "",
				});
				onOpenChange(false);
			},
		});
	};

	const handleClose = () => {
		if (!createMutation.isPending) {
			setFormData({
				user_request: "",
				selected_commands: DEFAULT_COMMANDS,
				sandbox_type: "git_worktree",
				github_issue_number: "",
			});
			onOpenChange(false);
		}
	};

	const toggleCommand = (command: WorkflowStep) => {
		setFormData((prev) => ({
			...prev,
			selected_commands: prev.selected_commands.includes(command)
				? prev.selected_commands.filter((c) => c !== command)
				: [...prev.selected_commands, command],
		}));
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-4xl">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle className="text-xl font-bold bg-gradient-to-r from-blue-400 to-cyan-500 text-transparent bg-clip-text">
							Create Work Order
						</DialogTitle>
						<DialogDescription>Create a new AI-driven development workflow for {repositoryName}</DialogDescription>
					</DialogHeader>

					{/* Two Column Layout */}
					<div className="grid grid-cols-2 gap-6 my-6">
						{/* Left Column - Basic Info */}
						<div className="space-y-4">
							{/* Repository Badge (read-only) */}
							<div className="p-3 bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-md">
								<p className="text-xs text-gray-600 dark:text-gray-400 mb-1">Repository:</p>
								<p className="text-sm font-mono text-blue-700 dark:text-blue-300">{repositoryName}</p>
							</div>

							{/* User Request (textarea, required) */}
							<div>
								<label
									htmlFor={userRequestId}
									className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
								>
									Task Description <span className="text-red-500">*</span>
								</label>
								<textarea
									id={userRequestId}
									placeholder="Describe what you want the AI agent to do..."
									rows={6}
									value={formData.user_request}
									onChange={(e) => setFormData((prev) => ({ ...prev, user_request: e.target.value }))}
									disabled={createMutation.isPending}
									className={cn(
										"w-full resize-none",
										"bg-white/50 dark:bg-black/70",
										"border border-gray-300 dark:border-gray-700",
										"text-gray-900 dark:text-white",
										"rounded-md py-2 px-3",
										"focus:outline-none focus:border-blue-400",
										"focus:shadow-[0_0_10px_rgba(59,130,246,0.2)]",
										"transition-all duration-300",
										"disabled:opacity-50 disabled:cursor-not-allowed",
									)}
									autoFocus
								/>
							</div>

							{/* Sandbox Type (radio) */}
							<div>
								<label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
									Sandbox Type
								</label>
								<div className="flex gap-4">
									<label className="flex items-center gap-2 cursor-pointer">
										<input
											type="radio"
											value="git_worktree"
											checked={formData.sandbox_type === "git_worktree"}
											onChange={(e) =>
												setFormData((prev) => ({ ...prev, sandbox_type: e.target.value as SandboxType }))
											}
											disabled={createMutation.isPending}
											className="w-4 h-4 text-blue-600"
										/>
										<span className="text-sm text-gray-700 dark:text-gray-300">Git Worktree</span>
									</label>
									<label className="flex items-center gap-2 cursor-pointer">
										<input
											type="radio"
											value="git_branch"
											checked={formData.sandbox_type === "git_branch"}
											onChange={(e) =>
												setFormData((prev) => ({ ...prev, sandbox_type: e.target.value as SandboxType }))
											}
											disabled={createMutation.isPending}
											className="w-4 h-4 text-blue-600"
										/>
										<span className="text-sm text-gray-700 dark:text-gray-300">Git Branch</span>
									</label>
								</div>
							</div>

							{/* GitHub Issue Number (optional) */}
							<div>
								<label
									htmlFor={issueNumberId}
									className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
								>
									GitHub Issue Number <span className="text-gray-400 text-xs">(optional)</span>
								</label>
								<Input
									id={issueNumberId}
									type="text"
									placeholder="123"
									value={formData.github_issue_number}
									onChange={(e) => setFormData((prev) => ({ ...prev, github_issue_number: e.target.value }))}
									disabled={createMutation.isPending}
									className={cn("w-full", "focus:border-blue-400 focus:shadow-[0_0_10px_rgba(59,130,246,0.2)]")}
								/>
							</div>
						</div>

						{/* Right Column - Workflow Steps */}
						<div className="space-y-4">
							<div>
								<label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
									Workflow Steps
								</label>
								<div className="space-y-2">
									{DEFAULT_COMMANDS.map((command) => (
										<label
											key={command}
											className={cn(
												"flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-all",
												"bg-white/50 dark:bg-black/50",
												"border border-gray-300 dark:border-gray-700",
												"hover:border-blue-400 dark:hover:border-blue-500",
												formData.selected_commands.includes(command) &&
													"border-blue-400 dark:border-blue-500 bg-blue-50/50 dark:bg-blue-900/20",
											)}
										>
											<input
												type="checkbox"
												checked={formData.selected_commands.includes(command)}
												onChange={() => toggleCommand(command)}
												disabled={createMutation.isPending}
												className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
											/>
											<span className="text-sm text-gray-700 dark:text-gray-300">{COMMAND_LABELS[command]}</span>
										</label>
									))}
								</div>
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={handleClose} disabled={createMutation.isPending}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="default"
							disabled={
								createMutation.isPending || !formData.user_request.trim() || formData.selected_commands.length === 0
							}
							className="shadow-lg shadow-blue-500/20"
						>
							{createMutation.isPending ? (
								<>
									<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									Creating...
								</>
							) : (
								"Create Work Order"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};
