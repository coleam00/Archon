import { Loader2 } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
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
import { useCreateProject } from "../hooks/useProjectQueries";
import type { CreateProjectRequest } from "../types";

interface NewProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ open, onOpenChange, onSuccess }) => {
  const projectNameId = useId();
  const projectDescriptionId = useId();

  const [formData, setFormData] = useState<CreateProjectRequest>({
    title: "",
    description: "",
  });

  const createProjectMutation = useCreateProject();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title.trim()) return;

    createProjectMutation.mutate(formData, {
      onSuccess: () => {
        setFormData({ title: "", description: "" });
        onOpenChange(false);
        onSuccess?.();
      },
    });
  };

  const handleClose = () => {
    if (!createProjectMutation.isPending) {
      setFormData({ title: "", description: "" });
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-purple-400 to-fuchsia-500 text-transparent bg-clip-text">
              Create New Project
            </DialogTitle>
            <DialogDescription>Start a new project to organize your tasks and documents.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            <div>
              <label
                htmlFor={projectNameId}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Project Name
              </label>
              <Input
                id={projectNameId}
                type="text"
                placeholder="Enter project name..."
                value={formData.title}
                onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                disabled={createProjectMutation.isPending}
                className={cn("w-full", "focus:border-purple-400 focus:shadow-[0_0_10px_rgba(168,85,247,0.2)]")}
                autoFocus
              />
            </div>

            <div>
              <label
                htmlFor={projectDescriptionId}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                Description
              </label>
              <textarea
                id={projectDescriptionId}
                placeholder="Enter project description..."
                rows={4}
                value={formData.description}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                disabled={createProjectMutation.isPending}
                className={cn(
                  "w-full resize-none",
                  "bg-white/50 dark:bg-black/70",
                  "border border-gray-300 dark:border-gray-700",
                  "text-gray-900 dark:text-white",
                  "rounded-md py-2 px-3",
                  "focus:outline-none focus:border-purple-400",
                  "focus:shadow-[0_0_10px_rgba(168,85,247,0.2)]",
                  "transition-all duration-300",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={createProjectMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={createProjectMutation.isPending || !formData.title.trim()}
              className="shadow-lg shadow-purple-500/20"
            >
              {createProjectMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Project"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
