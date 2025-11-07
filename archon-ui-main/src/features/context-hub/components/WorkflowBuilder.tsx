import { ArrowDown, ArrowUp, Plus, Trash2, AlertCircle } from "lucide-react";
import type React from "react";
import { Button } from "@/features/ui/primitives/button";
import { Label } from "@/features/ui/primitives/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { useStepTemplates } from "../hooks/useStepTemplates";
import type { WorkflowStep, StepType } from "../types";
import { STEP_TYPE_CONFIGS } from "../types";

interface WorkflowBuilderProps {
	steps: WorkflowStep[];
	onChange: (steps: WorkflowStep[]) => void;
	disabled?: boolean;
}

export const WorkflowBuilder: React.FC<WorkflowBuilderProps> = ({ steps, onChange, disabled = false }) => {
	const { data: availableSteps } = useStepTemplates();

	const addStep = () => {
		const newOrder = steps.length > 0 ? Math.max(...steps.map((s) => s.order)) + 1 : 1;
		const newStep: WorkflowStep = {
			step_type: "planning",
			order: newOrder,
			step_template_slug: "",
		};
		onChange([...steps, newStep]);
	};

	const removeStep = (index: number) => {
		const newSteps = steps.filter((_, i) => i !== index);
		// Reorder to ensure sequential order
		const reordered = newSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const moveStepUp = (index: number) => {
		if (index === 0) return;
		const newSteps = [...steps];
		[newSteps[index - 1], newSteps[index]] = [newSteps[index], newSteps[index - 1]];
		// Reorder
		const reordered = newSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const moveStepDown = (index: number) => {
		if (index === steps.length - 1) return;
		const newSteps = [...steps];
		[newSteps[index], newSteps[index + 1]] = [newSteps[index + 1], newSteps[index]];
		// Reorder
		const reordered = newSteps.map((step, i) => ({ ...step, order: i + 1 }));
		onChange(reordered);
	};

	const updateStep = (index: number, field: keyof WorkflowStep, value: string) => {
		const newSteps = [...steps];
		newSteps[index] = { ...newSteps[index], [field]: value };
		onChange(newSteps);
	};

	// Validation: Check for required step types
	const stepTypes = new Set(steps.map((s) => s.step_type));
	const hasPlanning = stepTypes.has("planning");
	const hasImplement = stepTypes.has("implement");
	const hasValidate = stepTypes.has("validate");
	const isValid = hasPlanning && hasImplement && hasValidate;

	const missingTypes: string[] = [];
	if (!hasPlanning) missingTypes.push("planning");
	if (!hasImplement) missingTypes.push("implement");
	if (!hasValidate) missingTypes.push("validate");

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<Label>Workflow Steps ({steps.length})</Label>
				<Button type="button" size="sm" onClick={addStep} disabled={disabled} className="gap-2">
					<Plus className="w-4 h-4" />
					Add Step
				</Button>
			</div>

			{/* Validation Message */}
			{!isValid && steps.length > 0 && (
				<div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-500/30">
					<AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
					<div>
						<p className="text-sm font-medium text-red-800 dark:text-red-300">Invalid Workflow</p>
						<p className="text-xs text-red-700 dark:text-red-400 mt-1">
							Missing required step types: <strong>{missingTypes.join(", ")}</strong>
						</p>
					</div>
				</div>
			)}

			{/* Steps List */}
			<div className="space-y-3">
				{steps.map((step, index) => {
					const stepTypeConfig = STEP_TYPE_CONFIGS[step.step_type];
					const stepsOfType = availableSteps?.filter((s) => s.step_type === step.step_type) || [];

					return (
						<div
							key={index}
							className="flex items-start gap-3 p-4 rounded-lg border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-gray-800/50"
						>
							{/* Step Number */}
							<div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center border border-purple-500/30 font-semibold text-sm text-purple-700 dark:text-purple-300">
								{index + 1}
							</div>

							{/* Step Configuration */}
							<div className="flex-1 space-y-3">
								{/* Step Type */}
								<div>
									<Label className="text-xs">Step Type</Label>
									<Select
										value={step.step_type}
										onValueChange={(value: StepType) => updateStep(index, "step_type", value)}
										disabled={disabled}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="planning">Planning</SelectItem>
											<SelectItem value="implement">Implement</SelectItem>
											<SelectItem value="validate">Validate</SelectItem>
											<SelectItem value="prime">Prime</SelectItem>
											<SelectItem value="git">Git</SelectItem>
										</SelectContent>
									</Select>
								</div>

								{/* Step Template */}
								<div>
									<Label className="text-xs">Step Template</Label>
									<Select
										value={step.step_template_slug}
										onValueChange={(value) => updateStep(index, "step_template_slug", value)}
										disabled={disabled}
									>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select step template..." />
										</SelectTrigger>
										<SelectContent>
											{stepsOfType.length === 0 ? (
												<div className="px-2 py-1.5 text-sm text-gray-500">
													No {stepTypeConfig.label.toLowerCase()} steps available
												</div>
											) : (
												stepsOfType.map((stepTemplate) => (
													<SelectItem key={stepTemplate.slug} value={stepTemplate.slug}>
														{stepTemplate.name}
													</SelectItem>
												))
											)}
										</SelectContent>
									</Select>
								</div>
							</div>

							{/* Actions */}
							<div className="flex flex-col gap-1">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => moveStepUp(index)}
									disabled={disabled || index === 0}
									title="Move up"
								>
									<ArrowUp className="w-4 h-4" />
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => moveStepDown(index)}
									disabled={disabled || index === steps.length - 1}
									title="Move down"
								>
									<ArrowDown className="w-4 h-4" />
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => removeStep(index)}
									disabled={disabled}
									title="Remove step"
									className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
								>
									<Trash2 className="w-4 h-4" />
								</Button>
							</div>
						</div>
					);
				})}

				{/* Empty State */}
				{steps.length === 0 && (
					<div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-lg">
						<p className="text-gray-600 dark:text-gray-400 mb-3">No steps added yet</p>
						<Button type="button" size="sm" onClick={addStep} disabled={disabled} className="gap-2">
							<Plus className="w-4 h-4" />
							Add First Step
						</Button>
					</div>
				)}
			</div>

			{/* Validation Summary */}
			{steps.length > 0 && (
				<div className="flex items-center gap-6 text-xs">
					<div className="flex items-center gap-2">
						<div className={`w-3 h-3 rounded-full ${hasPlanning ? "bg-green-500" : "bg-red-500"}`} />
						<span className={hasPlanning ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
							Planning
						</span>
					</div>
					<div className="flex items-center gap-2">
						<div className={`w-3 h-3 rounded-full ${hasImplement ? "bg-green-500" : "bg-red-500"}`} />
						<span className={hasImplement ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
							Implement
						</span>
					</div>
					<div className="flex items-center gap-2">
						<div className={`w-3 h-3 rounded-full ${hasValidate ? "bg-green-500" : "bg-red-500"}`} />
						<span className={hasValidate ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
							Validate
						</span>
					</div>
				</div>
			)}
		</div>
	);
};
