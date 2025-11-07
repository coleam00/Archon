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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { useCreateStepTemplate } from "../hooks/useStepTemplates";
import type { CreateStepTemplateRequest, StepType } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { SubStepBuilder } from "./SubStepBuilder";

interface CreateStepModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateStepModal: React.FC<CreateStepModalProps> = ({ open, onOpenChange }) => {
  const nameId = useId();
  const slugId = useId();
  const descriptionId = useId();

  const [formData, setFormData] = useState<CreateStepTemplateRequest>({
    step_type: "planning",
    name: "",
    slug: "",
    description: "",
    prompt_template: "",
    agent_template_id: null,
    sub_steps: [],
    metadata: {},
  });

  const createMutation = useCreateStepTemplate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.slug.trim() || !formData.prompt_template.trim()) return;

    createMutation.mutate(formData, {
      onSuccess: () => {
        setFormData({
          step_type: "planning",
          name: "",
          slug: "",
          description: "",
          prompt_template: "",
          agent_template_id: null,
          sub_steps: [],
          metadata: {},
        });
        onOpenChange(false);
      },
    });
  };

  const handleClose = () => {
    if (!createMutation.isPending) {
      setFormData({
        step_type: "planning",
        name: "",
        slug: "",
        description: "",
        prompt_template: "",
        agent_template_id: null,
        sub_steps: [],
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
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-green-400 to-emerald-500 text-transparent bg-clip-text">
              Create Step Template
            </DialogTitle>
            <DialogDescription>Define a reusable workflow step with prompt template.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            <div>
              <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Step Name *
              </label>
              <Input
                id={nameId}
                type="text"
                placeholder="e.g., Standard Planning"
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
                placeholder="e.g., standard-planning"
                value={formData.slug}
                onChange={(e) => setFormData((prev) => ({ ...prev, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') }))}
                disabled={createMutation.isPending}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Step Type *
              </label>
              <Select
                value={formData.step_type}
                onValueChange={(value: StepType) => setFormData((prev) => ({ ...prev, step_type: value }))}
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
              <MarkdownEditor
                label="Prompt Template *"
                value={formData.prompt_template}
                onChange={(value) => setFormData((prev) => ({ ...prev, prompt_template: value }))}
                placeholder="Define the step's prompt in Markdown. Use {{variables}} for dynamic values..."
                disabled={createMutation.isPending}
                minHeight="250px"
              />
            </div>

            <div>
              <SubStepBuilder
                subSteps={formData.sub_steps || []}
                onChange={(sub_steps) => setFormData((prev) => ({ ...prev, sub_steps }))}
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
              variant="green"
              disabled={createMutation.isPending || !formData.name.trim() || !formData.slug.trim() || !formData.prompt_template.trim()}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Step"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
