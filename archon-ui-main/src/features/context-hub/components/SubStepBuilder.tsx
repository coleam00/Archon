import { ArrowDown, ArrowUp, Plus, Trash2, AlertCircle } from "lucide-react";
import type React from "react";
import { Button } from "@/features/ui/primitives/button";
import { Label } from "@/features/ui/primitives/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { Textarea } from "@/features/ui/primitives/textarea";
import { Input } from "@/features/ui/primitives/input";
import { Switch } from "@/features/ui/primitives/switch";
import { useAgentTemplates } from "../hooks/useAgentTemplates";
import type { SubStep } from "../types";

interface SubStepBuilderProps {
	subSteps: SubStep[];
	onChange: (subSteps: SubStep[]) => void;
	disabled?: boolean;
}

export const SubStepBuilder: React.FC<SubStepBuilderProps> = ({ subSteps, onChange, disabled = false }) => {
	const { data: availableAgents } = useAgentTemplates();

	const addSubStep = () => {
		const newOrder = subSteps.length > 0 ? Math.max(...subSteps.map((s) => s.order)) + 1 : 1;
		const newSubStep: SubStep = {
			order: newOrder,
			name: "",
			agent_template_slug: "",
			prompt_template: "",
			required: true,
		};
		onChange([...subSteps, newSubStep]);
	};

	const removeSubStep = (index: number) => {
		const newSubSteps = subSteps.filter((_, i) => i !== index);
		// Reorder to ensure sequential order
		const reordered = newSubSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const moveSubStepUp = (index: number) => {
		if (index === 0) return;
		const newSubSteps = [...subSteps];
		[newSubSteps[index - 1], newSubSteps[index]] = [newSubSteps[index], newSubSteps[index - 1]];
		// Reorder
		const reordered = newSubSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const moveSubStepDown = (index: number) => {
		if (index === subSteps.length - 1) return;
		const newSubSteps = [...subSteps];
		[newSubSteps[index], newSubSteps[index + 1]] = [newSubSteps[index + 1], newSubSteps[index]];
		// Reorder
		const reordered = newSubSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const updateSubStep = (index: number, updates: Partial<SubStep>) => {
		const newSubSteps = [...subSteps];
		newSubSteps[index] = { ...newSubSteps[index], ...updates };
		onChange(newSubSteps);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<Label>Sub-Steps (Multi-Agent Workflow)</Label>
					<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
						Configure multiple agents to execute this step sequentially
					</p>
				</div>
				<Button type="button" size="sm" onClick={addSubStep} disabled={disabled} className="gap-2">
					<Plus className="w-4 h-4" />
					Add Sub-Step
				</Button>
			</div>

			{/* Info Banner */}
			{subSteps.length === 0 && (
				<div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-500/30">
					<AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
					<div>
						<p className="text-sm font-medium text-blue-800 dark:text-blue-300">Single-Agent Mode</p>
						<p className="text-xs text-blue-700 dark:text-blue-400 mt-1">
							No sub-steps configured. This step will use the agent selected in the main form.
						</p>
					</div>
				</div>
			)}

			{/* Sub-Steps List */}
			<div className="space-y-3">
				{subSteps.map((subStep, index) => (
					<div
						key={index}
						className="flex items-start gap-3 p-4 rounded-lg border border-gray-300 dark:border-gray-600 bg-gradient-to-br from-cyan-50/50 to-blue-50/50 dark:from-cyan-900/10 dark:to-blue-900/10"
					>
						{/* Sub-Step Number */}
						<div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center border border-cyan-500/30 font-semibold text-sm text-cyan-700 dark:text-cyan-300">
							{index + 1}
						</div>

						{/* Sub-Step Configuration */}
						<div className="flex-1 space-y-3">
							{/* Name */}
							<div>
								<Label className="text-xs">Sub-Step Name</Label>
								<Input
									type="text"
									value={subStep.name}
									onChange={(e) => updateSubStep(index, { name: e.target.value })}
									placeholder="e.g., Security Review"
									disabled={disabled}
								/>
							</div>

							{/* Agent Selection */}
							<div>
								<Label className="text-xs">Agent Template</Label>
								<Select
									value={subStep.agent_template_slug}
									onValueChange={(value) => updateSubStep(index, { agent_template_slug: value })}
									disabled={disabled}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select agent..." />
									</SelectTrigger>
									<SelectContent>
										{availableAgents && availableAgents.length === 0 ? (
											<div className="px-2 py-1.5 text-sm text-gray-500">No agents available</div>
										) : (
											availableAgents?.map((agent) => (
												<SelectItem key={agent.slug} value={agent.slug}>
													{agent.name}
												</SelectItem>
											))
										)}
									</SelectContent>
								</Select>
							</div>

							{/* Prompt Template */}
							<div>
								<Label className="text-xs">Prompt Template</Label>
								<Textarea
									value={subStep.prompt_template}
									onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateSubStep(index, { prompt_template: e.target.value })}
									placeholder="Define this sub-step's specific prompt. Use {{variables}} for context..."
									className="min-h-[100px] font-mono text-sm"
									disabled={disabled}
								/>
							</div>

							{/* Required Toggle */}
							<div className="flex items-center gap-2">
								<Switch
									checked={subStep.required}
									onCheckedChange={(checked) => updateSubStep(index, { required: checked })}
									disabled={disabled}
								/>
								<Label className="text-xs">Required (workflow fails if this sub-step fails)</Label>
							</div>
						</div>

						{/* Actions */}
						<div className="flex flex-col gap-1">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => moveSubStepUp(index)}
								disabled={disabled || index === 0}
								title="Move up"
							>
								<ArrowUp className="w-4 h-4" />
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => moveSubStepDown(index)}
								disabled={disabled || index === subSteps.length - 1}
								title="Move down"
							>
								<ArrowDown className="w-4 h-4" />
							</Button>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => removeSubStep(index)}
								disabled={disabled}
								title="Remove sub-step"
								className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
							>
								<Trash2 className="w-4 h-4" />
							</Button>
						</div>
					</div>
				))}

				{/* Empty State within Builder */}
				{subSteps.length === 0 && (
					<div className="flex flex-col items-center justify-center py-6 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
						<p className="text-sm text-gray-600 dark:text-gray-400 mb-3">No sub-steps configured</p>
						<Button type="button" size="sm" onClick={addSubStep} disabled={disabled} className="gap-2">
							<Plus className="w-4 h-4" />
							Add First Sub-Step
						</Button>
					</div>
				)}
			</div>

			{/* Sub-Steps Summary */}
			{subSteps.length > 0 && (
				<div className="flex items-center gap-4 text-xs text-gray-600 dark:text-gray-400">
					<span>{subSteps.length} sub-step(s) configured</span>
					<span>•</span>
					<span>{subSteps.filter((s) => s.required).length} required</span>
					<span>•</span>
					<span>{subSteps.filter((s) => !s.agent_template_slug).length} missing agent assignment</span>
				</div>
			)}
		</div>
	);
};
