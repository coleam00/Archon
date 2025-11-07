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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { useStepTemplate, useUpdateStepTemplate } from "../hooks/useStepTemplates";
import type { StepType, SubStep, UpdateStepTemplateRequest } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { SubStepBuilder } from "./SubStepBuilder";

interface EditStepModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string | null;
}

export const EditStepModal: React.FC<EditStepModalProps> = ({ open, onOpenChange, slug }) => {
  const nameId = useId();
  const descriptionId = useId();

  const { data: template, isLoading, error } = useStepTemplate(slug || undefined);
  const updateMutation = useUpdateStepTemplate();

  const [formData, setFormData] = useState<UpdateStepTemplateRequest>({});
  const [subSteps, setSubSteps] = useState<SubStep[]>([]);

  useEffect(() => {
    if (template) {
      setFormData({
        name: template.name,
        description: template.description,
        step_type: template.step_type,
        prompt_template: template.prompt_template,
      });
      setSubSteps(template.sub_steps || []);
    }
  }, [template]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug) return;

    // Include sub-steps in the update
    const updates = {
      ...formData,
      sub_steps: subSteps,
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
      setSubSteps([]);
      onOpenChange(false);
    }
  };

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-green-600 mx-auto mb-2" />
              <p className="text-sm text-gray-600 dark:text-gray-400">Loading step template...</p>
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
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-green-400 to-emerald-500 text-transparent bg-clip-text">
              Edit Step Template
            </DialogTitle>
            <DialogDescription>
              Update step configuration. This will create a new version (v{template.version + 1}).
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 my-6 flex-1 overflow-y-auto">
            {/* Left Column: Basic Info + Prompt - Takes 2/3 width on large screens */}
            <div className="lg:col-span-2 space-y-4 px-1">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Step Name
                  </label>
                  <Input
                    id={nameId}
                    type="text"
                    value={formData.name || ""}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    disabled={updateMutation.isPending}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Step Type</label>
                  <Select
                    value={formData.step_type || template.step_type}
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
              </div>

              <div>
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

              <div>
                <MarkdownEditor
                  label="Prompt Template"
                  value={formData.prompt_template || ""}
                  onChange={(value) => setFormData((prev) => ({ ...prev, prompt_template: value }))}
                  placeholder="Define the step's prompt in Markdown. Use {{variables}} for dynamic values..."
                  disabled={updateMutation.isPending}
                  minHeight="400px"
                />
              </div>
            </div>

            {/* Right Column: Sub-Steps Builder - Takes 1/3 width on large screens */}
            <div className="lg:col-span-1">
              <SubStepBuilder subSteps={subSteps} onChange={setSubSteps} disabled={updateMutation.isPending} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="green" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Step"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
