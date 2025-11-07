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
import { Textarea } from "@/features/ui/primitives/textarea";
import { useAgentTemplate, useAgentTemplateVersions, useUpdateAgentTemplate } from "../hooks/useAgentTemplates";
import type { UpdateAgentTemplateRequest } from "../types";
import { MarkdownEditor } from "./MarkdownEditor";
import { ToolSelector } from "./ToolSelector";

interface EditAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string | null;
}

export const EditAgentModal: React.FC<EditAgentModalProps> = ({ open, onOpenChange, slug }) => {
  const nameId = useId();
  const descriptionId = useId();

  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  const { data: template, isLoading, error } = useAgentTemplate(slug || undefined, selectedVersion);
  const { data: versions, refetch: refetchVersions } = useAgentTemplateVersions(slug || undefined);
  const updateMutation = useUpdateAgentTemplate();

  const [formData, setFormData] = useState<UpdateAgentTemplateRequest>({});

  // Refetch versions when modal opens
  useEffect(() => {
    if (open && slug) {
      refetchVersions();
    }
  }, [open, slug, refetchVersions]);

  // When template data changes (including when version changes), update form
  useEffect(() => {
    if (template) {
      setFormData({
        name: template.name,
        description: template.description,
        system_prompt: template.system_prompt,
        model: template.model,
        temperature: template.temperature,
        tools: template.tools,
      });
    }
  }, [template]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug) return;

    updateMutation.mutate(
      { slug, updates: formData },
      {
        onSuccess: async () => {
          // Refetch versions to get the new version
          await refetchVersions();
          setSelectedVersion(undefined);
          onOpenChange(false);
        },
      },
    );
  };

  const handleVersionChange = (version: string) => {
    const versionNum = Number(version);
    console.log("[EditAgentModal] Changing to version:", versionNum);
    setSelectedVersion(versionNum);
  };

  // Debug log versions
  useEffect(() => {
    console.log("[EditAgentModal] Versions data:", versions);
    console.log("[EditAgentModal] Current template version:", template?.version);
    console.log("[EditAgentModal] Selected version:", selectedVersion);
  }, [versions, template, selectedVersion]);

  const handleClose = () => {
    if (!updateMutation.isPending) {
      setFormData({});
      setSelectedVersion(undefined);
      onOpenChange(false);
    }
  };

  if (isLoading) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-2xl">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-600 mx-auto mb-2" />
              <p className="text-sm text-gray-600 dark:text-gray-400">Loading template...</p>
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
            <DialogTitle className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-500 text-transparent bg-clip-text">
              Edit Agent Template
            </DialogTitle>
            <DialogDescription>
              Update agent configuration. This will create a new version (v{template.version + 1}).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 my-6 flex-1 overflow-y-auto">
            {/* Top Section: Name/Version (1/3) + Description (2/3) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: Name and Version - 1/3 width */}
              <div className="lg:col-span-1 space-y-4">
                <div>
                  <label htmlFor={nameId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Agent Name
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Version</label>
                  <Select
                    value={selectedVersion?.toString() || template?.version.toString() || ""}
                    onValueChange={handleVersionChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select version" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions && versions.length > 0 ? (
                        versions.map((v) => (
                          <SelectItem key={v.version} value={v.version.toString()}>
                            v{v.version} {v.version === template?.version && !selectedVersion ? "(current)" : ""}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="1" disabled>
                          Loading versions...
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Right Column: Description - 2/3 width */}
              <div className="lg:col-span-2">
                <label
                  htmlFor={descriptionId}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                >
                  Description
                </label>
                <Textarea
                  id={descriptionId}
                  value={formData.description || ""}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  disabled={updateMutation.isPending}
                  className="h-full min-h-[120px]"
                />
              </div>
            </div>

            {/* Two Column Layout: System Prompt (2/3) + Tools (1/3) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left Column: System Prompt - Takes 2/3 width on large screens */}
              <div className="lg:col-span-2 px-1">
                <MarkdownEditor
                  label="System Prompt"
                  value={formData.system_prompt || ""}
                  onChange={(value) => setFormData((prev) => ({ ...prev, system_prompt: value }))}
                  placeholder="Define the agent's behavior, expertise, and guidelines in Markdown..."
                  disabled={updateMutation.isPending}
                  minHeight="500px"
                />
              </div>

              {/* Right Column: Tool Selector - Takes 1/3 width on large screens */}
              <div className="lg:col-span-1">
                <ToolSelector
                  selectedTools={formData.tools || template.tools || []}
                  onChange={(tools) => setFormData((prev) => ({ ...prev, tools }))}
                  disabled={updateMutation.isPending}
                  label="Available Tools"
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={updateMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="cyan" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Agent"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
