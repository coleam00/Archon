/**
 * Add Repository Modal Component
 *
 * Modal for adding new configured repositories with GitHub verification.
 * Two-column layout: Left (2/3) for form fields, Right (1/3) for workflow steps.
 */

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Checkbox } from "@/features/ui/primitives/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/features/ui/primitives/dialog";
import { Input } from "@/features/ui/primitives/input";
import { Label } from "@/features/ui/primitives/label";
import { useCreateRepository } from "../hooks/useRepositoryQueries";
import type { WorkflowStep } from "../types";

export interface AddRepositoryModalProps {
  /** Whether modal is open */
  open: boolean;

  /** Callback to change open state */
  onOpenChange: (open: boolean) => void;
}

/**
 * All available workflow steps
 */
const WORKFLOW_STEPS: { value: WorkflowStep; label: string; description: string; dependsOn?: WorkflowStep[] }[] = [
  { value: "create-branch", label: "Create Branch", description: "Create a new git branch for isolated work" },
  { value: "planning", label: "Planning", description: "Generate implementation plan" },
  { value: "execute", label: "Execute", description: "Implement the planned changes" },
  {
    value: "prp-review",
    label: "Review/Fix",
    description: "Review implementation and fix issues",
    dependsOn: ["execute"],
  },
  { value: "commit", label: "Commit", description: "Commit changes to git", dependsOn: ["execute"] },
  { value: "create-pr", label: "Create PR", description: "Create pull request", dependsOn: ["commit"] },
];

/**
 * Default selected steps for new repositories
 */
const DEFAULT_STEPS: WorkflowStep[] = ["create-branch", "planning", "execute"];

export function AddRepositoryModal({ open, onOpenChange }: AddRepositoryModalProps) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [selectedSteps, setSelectedSteps] = useState<WorkflowStep[]>(DEFAULT_STEPS);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createRepository = useCreateRepository();

  /**
   * Reset form state
   */
  const resetForm = () => {
    setRepositoryUrl("");
    setSelectedSteps(DEFAULT_STEPS);
    setError("");
  };

  /**
   * Toggle workflow step selection
   * When unchecking a step, also uncheck steps that depend on it (cascade removal)
   */
  const toggleStep = (step: WorkflowStep) => {
    setSelectedSteps((prev) => {
      if (prev.includes(step)) {
        // Removing a step - also remove steps that depend on it
        const stepsToRemove = new Set([step]);

        // Find all steps that transitively depend on the one being removed (cascade)
        let changed = true;
        while (changed) {
          changed = false;
          WORKFLOW_STEPS.forEach((s) => {
            if (!stepsToRemove.has(s.value) && s.dependsOn?.some((dep) => stepsToRemove.has(dep))) {
              stepsToRemove.add(s.value);
              changed = true;
            }
          });
        }

        return prev.filter((s) => !stepsToRemove.has(s));
      }
      return [...prev, step];
    });
  };

  /**
   * Check if a step is disabled based on dependencies
   */
  const isStepDisabled = (step: (typeof WORKFLOW_STEPS)[number]): boolean => {
    if (!step.dependsOn) return false;
    return step.dependsOn.some((dep) => !selectedSteps.includes(dep));
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validation
    if (!repositoryUrl.trim()) {
      setError("Repository URL is required");
      return;
    }
    if (!repositoryUrl.includes("github.com")) {
      setError("Must be a GitHub repository URL");
      return;
    }
    if (selectedSteps.length === 0) {
      setError("At least one workflow step must be selected");
      return;
    }

    try {
      setIsSubmitting(true);
      await createRepository.mutateAsync({
        repository_url: repositoryUrl,
        verify: true,
      });

      // Success - close modal and reset form
      resetForm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create repository");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add Repository</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Left Column (2/3 width) - Form Fields */}
            <div className="col-span-2 space-y-4">
              {/* Repository URL */}
              <div className="space-y-2">
                <Label htmlFor="repository-url">Repository URL *</Label>
                <Input
                  id="repository-url"
                  type="url"
                  placeholder="https://github.com/owner/repository"
                  value={repositoryUrl}
                  onChange={(e) => setRepositoryUrl(e.target.value)}
                  aria-invalid={!!error}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  GitHub repository URL. We'll verify access and extract metadata automatically.
                </p>
              </div>

              {/* Info about auto-filled fields */}
              <div className="p-3 bg-blue-500/10 dark:bg-blue-400/10 border border-blue-500/20 dark:border-blue-400/20 rounded-lg">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  <strong>Auto-filled from GitHub:</strong>
                </p>
                <ul className="text-xs text-gray-600 dark:text-gray-400 mt-1 space-y-0.5 ml-4 list-disc">
                  <li>Display Name (can be customized later via Edit)</li>
                  <li>Owner/Organization</li>
                  <li>Default Branch</li>
                </ul>
              </div>
            </div>

            {/* Right Column (1/3 width) - Workflow Steps */}
            <div className="space-y-4">
              <Label>Default Workflow Steps</Label>
              <div className="space-y-2">
                {WORKFLOW_STEPS.map((step) => {
                  const isSelected = selectedSteps.includes(step.value);
                  const isDisabled = isStepDisabled(step);

                  return (
                    <div key={step.value} className="flex items-center gap-2">
                      <Checkbox
                        id={`step-${step.value}`}
                        checked={isSelected}
                        onCheckedChange={() => !isDisabled && toggleStep(step.value)}
                        disabled={isDisabled}
                        aria-label={step.label}
                      />
                      <Label htmlFor={`step-${step.value}`} className={isDisabled ? "text-gray-400" : ""}>
                        {step.label}
                      </Label>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Commit and PR require Execute</p>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mt-4 text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-6 mt-6 border-t border-gray-200 dark:border-gray-700">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} variant="cyan">
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                  Adding...
                </>
              ) : (
                "Add Repository"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
