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
import { useCreateAgentTemplate } from "../hooks/useAgentTemplates";
import type { CreateAgentTemplateRequest } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { ToolSelector } from "./ToolSelector";

interface CreateAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateAgentModal: React.FC<CreateAgentModalProps> = ({ open, onOpenChange }) => {
  const nameId = useId();
  const slugId = useId();
  const descriptionId = useId();

  const [formData, setFormData] = useState<CreateAgentTemplateRequest>({
    name: "",
    slug: "",
    description: "",
    system_prompt: "",
    model: "sonnet",
    temperature: 0.0,
    tools: [],
    standards: {},
    metadata: {},
  });

  const createMutation = useCreateAgentTemplate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.slug.trim() || !formData.system_prompt.trim()) return;

    createMutation.mutate(formData, {
      onSuccess: () => {
        setFormData({
          name: "",
          slug: "",
          description: "",
          system_prompt: "",
          model: "sonnet",
          temperature: 0.0,
          tools: [],
          standards: {},
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
        system_prompt: "",
        model: "sonnet",
        temperature: 0.0,
        tools: [],
        standards: {},
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
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-500 text-transparent bg-clip-text">
              Create Agent Template
            </DialogTitle>
            <DialogDescription>Define a reusable agent configuration with prompts, tools, and standards.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 my-6">
            <div>
              <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Agent Name *
              </label>
              <Input
                id={nameId}
                type="text"
                placeholder="e.g., Python Backend Expert"
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
                placeholder="e.g., python-backend-expert"
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
                placeholder="Brief description of this agent"
                value={formData.description || ""}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                disabled={createMutation.isPending}
              />
            </div>

            <div>
              <MarkdownEditor
                label="System Prompt *"
                value={formData.system_prompt}
                onChange={(value) => setFormData((prev) => ({ ...prev, system_prompt: value }))}
                placeholder="Define the agent's behavior, expertise, and guidelines in Markdown..."
                disabled={createMutation.isPending}
                minHeight="250px"
              />
            </div>

            <div>
              <ToolSelector
                selectedTools={formData.tools || []}
                onChange={(tools) => setFormData((prev) => ({ ...prev, tools }))}
                disabled={createMutation.isPending}
                label="Available Tools"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="cyan"
              disabled={createMutation.isPending || !formData.name.trim() || !formData.slug.trim() || !formData.system_prompt.trim()}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Agent"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
