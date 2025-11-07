import { Loader2 } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
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
import { useCreateWorkflowTemplate } from "../hooks/useWorkflowTemplates";
import type { CreateWorkflowTemplateRequest } from "../types";
import { WorkflowBuilder } from "./WorkflowBuilder";

interface CreateWorkflowModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateWorkflowModal: React.FC<CreateWorkflowModalProps> = ({ open, onOpenChange }) => {
  const nameId = useId();
  const slugId = useId();
  const descriptionId = useId();

  const [formData, setFormData] = useState<CreateWorkflowTemplateRequest>({
    name: "",
    slug: "",
    description: "",
    steps: [],
    metadata: {},
  });

  const createMutation = useCreateWorkflowTemplate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.slug.trim() || formData.steps.length === 0) return;

    createMutation.mutate(formData, {
      onSuccess: () => {
        setFormData({
          name: "",
          slug: "",
          description: "",
          steps: [],
          metadata: {},
        });
        onOpenChange(false);
      },
    });
  };

  const handleClose = () => {
    if (!createMutation.isPending) {
      setFormData({
        name: "",
        slug: "",
        description: "",
        steps: [],
        metadata: {},
      });
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text">
              Create Workflow Template
            </DialogTitle>
            <DialogDescription>Define a reusable workflow sequence.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            <div>
              <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Workflow Name *
              </label>
              <Input
                id={nameId}
                type="text"
                placeholder="e.g., Standard Dev Workflow"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                disabled={createMutation.isPending}
                required
              />
            </div>

            <div>
              <label htmlFor={slugId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Slug * (unique identifier)
              </label>
              <Input
                id={slugId}
                type="text"
                placeholder="e.g., standard-dev"
                value={formData.slug}
                onChange={(e) => setFormData((prev) => ({ ...prev, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                disabled={createMutation.isPending}
                required
              />
            </div>

            <div>
              <label htmlFor={descriptionId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <Input
                id={descriptionId}
                type="text"
                placeholder="Brief description"
                value={formData.description || ""}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                disabled={createMutation.isPending}
              />
            </div>

            <div>
              <WorkflowBuilder
                steps={formData.steps}
                onChange={(steps) => setFormData((prev) => ({ ...prev, steps }))}
                disabled={createMutation.isPending}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={createMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="knowledge"
              disabled={createMutation.isPending || !formData.name.trim() || !formData.slug.trim() || formData.steps.length === 0}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Workflow"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
