import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/features/ui/primitives/dialog";
import { Input } from "@/features/ui/primitives/input";
import { useUpdateWorkflowTemplate, useWorkflowTemplate } from "../hooks/useWorkflowTemplates";
import type { UpdateWorkflowTemplateRequest, WorkflowStep } from "../types";
import { WorkflowFlowBuilder } from "./workflow-builder/WorkflowFlowBuilder";

interface EditWorkflowModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string | null;
}

export const EditWorkflowModal: React.FC<EditWorkflowModalProps> = ({ open, onOpenChange, slug }) => {
  const nameId = useId();
  const descriptionId = useId();

  const { data: template, isLoading, error } = useWorkflowTemplate(slug || undefined);
  const updateMutation = useUpdateWorkflowTemplate();

  const [formData, setFormData] = useState<UpdateWorkflowTemplateRequest>({});
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);

  useEffect(() => {
    if (template) {
      setFormData({
        name: template.name,
        description: template.description,
      });
      setWorkflowSteps(template.steps || []);
    }
  }, [template]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug) return;

    // Include steps in the update
    const updates = {
      ...formData,
      steps: workflowSteps,
    };

    updateMutation.mutate(
      { slug, updates },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      },
    );
  };

  const handleClose = () => {
    if (!updateMutation.isPending) {
      setFormData({});
      setWorkflowSteps([]);
      onOpenChange(false);
    }
  };

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-purple-600 mx-auto mb-2" />
              <p className="text-sm text-gray-600 dark:text-gray-400">Loading workflow template...</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (error) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-center justify-center py-12">
            <p className="text-red-600 dark:text-red-400">Error loading template: {String(error)}</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (!template) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text">
              Edit Workflow Template
            </DialogTitle>
            <DialogDescription>Update workflow configuration and step sequence.</DialogDescription>
          </DialogHeader>

          <div className="space-y-6 my-6 flex-1 overflow-hidden flex flex-col">
            {/* Top Row: Workflow Name (1/3) and Description (2/3) */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Workflow Name
                </label>
                <Input
                  id={nameId}
                  type="text"
                  value={formData.name || ""}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  disabled={updateMutation.isPending}
                />
              </div>

              <div className="col-span-2">
                <label
                  htmlFor={descriptionId}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Description
                </label>
                <Input
                  id={descriptionId}
                  type="text"
                  value={formData.description || ""}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  disabled={updateMutation.isPending}
                />
              </div>
            </div>

            {/* Full Width: Workflow Flow Builder */}
            <div className="flex flex-col flex-1 min-h-[600px] overflow-hidden">
              <WorkflowFlowBuilder
                steps={workflowSteps}
                onChange={setWorkflowSteps}
                disabled={updateMutation.isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="knowledge" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Workflow"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
