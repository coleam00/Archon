/**
 * Edit Repository Modal Component
 *
 * Modal for editing configured repository settings with tabs:
 * - Basic Info: Repository info and workflow steps
 * - Template: Workflow template and coding standards
 * - Priming Context: JSON editor for repository-specific context
 * - Agent Overrides: Override agent tools/standards per repository
 */

import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Checkbox } from "@/features/ui/primitives/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/features/ui/primitives/dialog";
import { Label } from "@/features/ui/primitives/label";
import { SimpleTooltip, TooltipProvider } from "@/features/ui/primitives/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/features/ui/primitives/tabs";
import { Textarea } from "@/features/ui/primitives/textarea";
import { useUpdateRepository } from "../hooks/useRepositoryQueries";
import { useAgentWorkOrdersStore } from "../state/agentWorkOrdersStore";
import type { WorkflowStep } from "../types";
import {
  applyWorkflowTemplate,
  assignCodingStandards,
  deleteAgentOverride,
  listAgentOverrides,
  updatePrimingContext,
  upsertAgentOverride,
} from "../services/repositoryService";
import { useWorkflowTemplates } from "@/features/context-hub/hooks/useWorkflowTemplates";
import { useCodingStandards } from "@/features/context-hub/hooks/useCodingStandards";
import { useAgentTemplates } from "@/features/context-hub/hooks/useAgentTemplates";
import type { RepositoryAgentOverride } from "../types/repository";

export interface EditRepositoryModalProps {
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

export function EditRepositoryModal({ open, onOpenChange }: EditRepositoryModalProps) {
  // Read editing repository from Zustand store
  const repository = useAgentWorkOrdersStore((s) => s.editingRepository);

  const [selectedSteps, setSelectedSteps] = useState<WorkflowStep[]>([]);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const updateRepository = useUpdateRepository();

  // Phase 2: Template tab state
  const [selectedWorkflowTemplateId, setSelectedWorkflowTemplateId] = useState<string | null>(null);
  const [selectedCodingStandardIds, setSelectedCodingStandardIds] = useState<string[]>([]);

  // Phase 2: Priming context tab state
  const [primingContextJson, setPrimingContextJson] = useState("");
  const [primingContextError, setPrimingContextError] = useState<string | null>(null);

  // Phase 2: Agent overrides tab state
  const [agentOverrides, setAgentOverrides] = useState<RepositoryAgentOverride[]>([]);
  const [isLoadingOverrides, setIsLoadingOverrides] = useState(false);
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(new Set());
  const [editingOverrides, setEditingOverrides] = useState<Record<string, { tools: string[] | null; standards: Record<string, any> | null }>>({});

  // Fetch Context Hub data
  const { data: workflowTemplates } = useWorkflowTemplates(true);
  const { data: codingStandards } = useCodingStandards({ is_active: true });
  const { data: agentTemplates } = useAgentTemplates(true);

  /**
   * Pre-populate form when repository changes
   */
  useEffect(() => {
    if (repository) {
      setSelectedSteps(repository.default_commands);
      setSelectedWorkflowTemplateId(repository.workflow_template_id);
      setSelectedCodingStandardIds(repository.coding_standard_ids || []);
      setPrimingContextJson(JSON.stringify(repository.priming_context || {}, null, 2));
      setPrimingContextError(null);
      setError("");
    }
  }, [repository]);

  /**
   * Load agent overrides when repository changes
   */
  useEffect(() => {
    if (repository && open) {
      setIsLoadingOverrides(true);
      listAgentOverrides(repository.id)
        .then((overrides) => {
          setAgentOverrides(overrides);
          // Initialize editing state with current override values
          const editing: Record<string, { tools: string[] | null; standards: Record<string, any> | null }> = {};
          overrides.forEach((override) => {
            editing[override.agent_template_id] = {
              tools: override.override_tools,
              standards: override.override_standards,
            };
          });
          setEditingOverrides(editing);
          // Start with all cards collapsed (user can expand to edit)
          setExpandedOverrides(new Set());
        })
        .catch((err) => {
          console.error("Failed to load agent overrides:", err);
          setAgentOverrides([]);
        })
        .finally(() => {
          setIsLoadingOverrides(false);
        });
    }
  }, [repository, open]);

  /**
   * Toggle workflow step selection
   */
  const toggleStep = (step: WorkflowStep) => {
    setSelectedSteps((prev) => {
      if (prev.includes(step)) {
        const stepsToRemove = new Set([step]);
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

  const isStepDisabled = (step: (typeof WORKFLOW_STEPS)[number]): boolean => {
    if (!step.dependsOn) return false;
    return step.dependsOn.some((dep) => !selectedSteps.includes(dep));
  };

  /**
   * Handle priming context JSON change
   */
  const handlePrimingContextChange = (value: string) => {
    setPrimingContextJson(value);
    try {
      JSON.parse(value);
      setPrimingContextError(null);
    } catch (_e) {
      setPrimingContextError("Invalid JSON");
    }
  };

  /**
   * Handle form submission (Basic Info tab)
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repository) return;

    setError("");

    if (selectedSteps.length === 0) {
      setError("At least one workflow step must be selected");
      return;
    }

    try {
      setIsSubmitting(true);
      const sortedSteps = WORKFLOW_STEPS.filter((step) => selectedSteps.includes(step.value)).map((step) => step.value);

      await updateRepository.mutateAsync({
        id: repository.id,
        request: {
          default_sandbox_type: repository.default_sandbox_type,
          default_commands: sortedSteps,
        },
      });

      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update repository");
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Handle template configuration save
   */
  const handleTemplateSave = async () => {
    if (!repository) return;

    try {
      setIsSubmitting(true);
      setError("");

      // Always call applyWorkflowTemplate (even if null to clear it)
      await applyWorkflowTemplate(repository.id, selectedWorkflowTemplateId || null);

      // Always assign coding standards (even if empty array)
      await assignCodingStandards(repository.id, selectedCodingStandardIds);

      // Refresh repository data to show updated values
      await updateRepository.mutateAsync({
        id: repository.id,
        request: {},
      });

      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save template configuration");
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Handle priming context save
   */
  const handlePrimingContextSave = async () => {
    if (!repository || primingContextError) return;

    try {
      setIsSubmitting(true);
      setError("");

      const parsed = JSON.parse(primingContextJson);
      await updatePrimingContext(repository.id, parsed);

      // Refresh repository data
      await updateRepository.mutateAsync({
        id: repository.id,
        request: {},
      });

      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save priming context");
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Handle agent override save
   */
  const handleAgentOverrideSave = async (agentTemplateId: string, overrideTools: string[] | null, overrideStandards: Record<string, any> | null) => {
    if (!repository) return;

    try {
      setError("");
      setIsSubmitting(true);
      
      console.log("[EditRepositoryModal] Saving agent override:", {
        repositoryId: repository.id,
        agentTemplateId,
        overrideTools,
        overrideStandards,
      });

      await upsertAgentOverride(repository.id, agentTemplateId, {
        override_tools: overrideTools,
        override_standards: overrideStandards,
      });

      // Reload overrides
      const overrides = await listAgentOverrides(repository.id);
      setAgentOverrides(overrides);
      
      // Update editing state
      setEditingOverrides((prev) => ({
        ...prev,
        [agentTemplateId]: { tools: overrideTools, standards: overrideStandards },
      }));
      
      setError(""); // Clear any previous errors on success
    } catch (err) {
      console.error("Failed to save agent override:", err);
      let errorMessage = "Failed to save agent override";
      
      if (err instanceof Error) {
        errorMessage = err.message;
        // Provide more helpful error messages
        if (errorMessage.includes("Not Found") || errorMessage.includes("404")) {
          errorMessage = `Agent template not found. Please ensure the agent exists in Context Hub and try again. (Agent ID: ${agentTemplateId})`;
        } else if (errorMessage.includes("foreign key") || errorMessage.includes("constraint")) {
          errorMessage = `Invalid agent template. The agent template ID does not exist in the database. Please select a valid agent from Context Hub.`;
        }
      }
      
      setError(errorMessage);
      // Don't close modal on error, let user see the error
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Toggle expanded state for an agent override card
   */
  const toggleOverrideExpanded = (agentTemplateId: string) => {
    setExpandedOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(agentTemplateId)) {
        next.delete(agentTemplateId);
      } else {
        next.add(agentTemplateId);
      }
      return next;
    });
  };

  /**
   * Handle agent override delete
   */
  const handleAgentOverrideDelete = async (agentTemplateId: string) => {
    if (!repository) return;

    try {
      await deleteAgentOverride(repository.id, agentTemplateId);

      // Reload overrides
      const overrides = await listAgentOverrides(repository.id);
      setAgentOverrides(overrides);
    } catch (err) {
      console.error("Failed to delete agent override:", err);
      setError(err instanceof Error ? err.message : "Failed to delete agent override");
    }
  };

  if (!repository) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Repository</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="basic" className="pt-4">
          <TabsList>
            <TabsTrigger value="basic">Basic Info</TabsTrigger>
            <TabsTrigger value="template">Template</TabsTrigger>
            <TabsTrigger value="priming">Priming Context</TabsTrigger>
            <TabsTrigger value="agents">Agent Overrides</TabsTrigger>
          </TabsList>

          {/* Tab 1: Basic Info */}
          <TabsContent value="basic">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Left Column (2/3 width) - Repository Info */}
                <div className="col-span-2 space-y-4">
                  <div className="p-4 bg-gray-500/10 dark:bg-gray-400/10 border border-gray-500/20 dark:border-gray-400/20 rounded-lg space-y-3">
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Repository Information</h4>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">URL: </span>
                        <span className="text-gray-900 dark:text-white font-mono text-xs">{repository.repository_url}</span>
                      </div>
                      {repository.display_name && (
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Name: </span>
                          <span className="text-gray-900 dark:text-white">{repository.display_name}</span>
                        </div>
                      )}
                      {repository.owner && (
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Owner: </span>
                          <span className="text-gray-900 dark:text-white">{repository.owner}</span>
                        </div>
                      )}
                      {repository.default_branch && (
                        <div>
                          <span className="text-gray-500 dark:text-gray-400">Branch: </span>
                          <span className="text-gray-900 dark:text-white font-mono text-xs">{repository.default_branch}</span>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      Repository metadata is auto-filled from GitHub and cannot be edited directly.
                    </p>
                  </div>
                </div>

                {/* Right Column (1/3 width) - Workflow Steps */}
                <div className="space-y-4">
                  <Label>Default Workflow Steps</Label>
                  <TooltipProvider>
                    <div className="space-y-2">
                      {WORKFLOW_STEPS.map((step) => {
                        const isSelected = selectedSteps.includes(step.value);
                        const isDisabledForEnable = isStepDisabled(step);
                        const tooltipMessage =
                          isDisabledForEnable && step.dependsOn
                            ? `Requires: ${step.dependsOn.map((dep) => WORKFLOW_STEPS.find((s) => s.value === dep)?.label ?? dep).join(", ")}`
                            : undefined;

                        const checkbox = (
                          <Checkbox
                            id={`edit-step-${step.value}`}
                            checked={isSelected}
                            onCheckedChange={() => {
                              if (!isDisabledForEnable) {
                                toggleStep(step.value);
                              }
                            }}
                            disabled={isDisabledForEnable}
                            aria-label={step.label}
                          />
                        );

                        return (
                          <div key={step.value} className="flex items-center gap-2">
                            {tooltipMessage ? (
                              <SimpleTooltip content={tooltipMessage} side="right">
                                {checkbox}
                              </SimpleTooltip>
                            ) : (
                              checkbox
                            )}
                            <Label
                              htmlFor={`edit-step-${step.value}`}
                              className={
                                isDisabledForEnable
                                  ? "text-gray-400 dark:text-gray-500 cursor-not-allowed"
                                  : "cursor-pointer"
                              }
                            >
                              {step.label}
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                  </TooltipProvider>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Commit and PR require Execute</p>
                </div>
              </div>

              {error && (
                <div className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} variant="cyan">
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                      Updating...
                    </>
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </div>
            </form>
          </TabsContent>

          {/* Tab 2: Template Configuration */}
          <TabsContent value="template" className="space-y-6">
            <div className="space-y-4">
              <div>
                <Label htmlFor="workflow-template">Workflow Template</Label>
                <select
                  id="workflow-template"
                  className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
                  value={selectedWorkflowTemplateId || ""}
                  onChange={(e) => setSelectedWorkflowTemplateId(e.target.value || null)}
                >
                  <option value="">None (use default)</option>
                  {workflowTemplates?.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Select a workflow template from Context Hub to apply to this repository
                </p>
              </div>

              <div>
                <Label>Coding Standards</Label>
                <div className="space-y-2 mt-2 max-h-60 overflow-y-auto border border-gray-300 dark:border-gray-700 rounded-md p-3">
                  {codingStandards?.map((standard) => {
                    const isSelected = selectedCodingStandardIds.includes(standard.id);
                    return (
                      <div key={standard.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`coding-standard-${standard.id}`}
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedCodingStandardIds((prev) => [...prev, standard.id]);
                            } else {
                              setSelectedCodingStandardIds((prev) => prev.filter((id) => id !== standard.id));
                            }
                          }}
                        />
                        <Label htmlFor={`coding-standard-${standard.id}`} className="cursor-pointer">
                          {standard.name} ({standard.language})
                        </Label>
                      </div>
                    );
                  })}
                  {(!codingStandards || codingStandards.length === 0) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No coding standards available</p>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Select coding standards to apply to this repository
                </p>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="button" onClick={handleTemplateSave} disabled={isSubmitting} variant="cyan">
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                    Saving...
                  </>
                ) : (
                  "Save Template Configuration"
                )}
              </Button>
            </div>
          </TabsContent>

          {/* Tab 3: Priming Context */}
          <TabsContent value="priming" className="space-y-6">
            <div>
              <Label htmlFor="priming-context">Priming Context (JSON)</Label>
              <Textarea
                id="priming-context"
                value={primingContextJson}
                onChange={(e) => handlePrimingContextChange(e.target.value)}
                className="font-mono text-sm min-h-[400px] mt-2"
                disabled={isSubmitting}
              />
              {primingContextError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-1">{primingContextError}</p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Repository-specific context: paths, architecture, conventions. Example: {"{"}"paths": {"{"}"frontend": "apps/web/src"{"}"}, "architecture": "Monorepo"{"}"}
              </p>
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handlePrimingContextSave}
                disabled={isSubmitting || !!primingContextError}
                variant="cyan"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
                    Saving...
                  </>
                ) : (
                  "Save Priming Context"
                )}
              </Button>
            </div>
          </TabsContent>

          {/* Tab 4: Agent Overrides */}
          <TabsContent value="agents" className="space-y-6">
            <div>
              <Label>Agent Overrides</Label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
                Add repository-specific instructions for agents. These are additional context that supplements the base agent template. The agent will still use its root system prompt and configuration from the template; these overrides add extra tools or standards specific to this repository.
              </p>

              {isLoadingOverrides ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-cyan-600" />
                </div>
              ) : (
                <div className="space-y-4">
                  {agentOverrides.map((override) => {
                    const agentTemplate = agentTemplates?.find((a) => a.id === override.agent_template_id);
                    const isExpanded = expandedOverrides.has(override.agent_template_id);
                    const editingState = editingOverrides[override.agent_template_id] || { tools: null, standards: null };
                    
                    return (
                      <div
                        key={override.id}
                        className="bg-gray-500/10 dark:bg-gray-400/10 border border-gray-500/20 dark:border-gray-400/20 rounded-lg overflow-hidden"
                      >
                        {/* Collapsible Header */}
                        <div
                          className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-500/5 dark:hover:bg-gray-400/5 transition-colors"
                          onClick={() => toggleOverrideExpanded(override.agent_template_id)}
                        >
                          <div className="flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                            ) : (
                              <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                            )}
                            <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
                              {agentTemplate?.name || `Agent ${override.agent_template_id}`}
                            </h4>
                            {agentTemplate && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                ({agentTemplate.tools.length} tools, {Object.keys(agentTemplate.standards || {}).length} standards)
                              </span>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAgentOverrideDelete(override.agent_template_id);
                            }}
                          >
                            Delete
                          </Button>
                        </div>

                        {/* Expanded Content */}
                        {isExpanded && agentTemplate && (
                          <div className="px-4 pb-4 space-y-4 border-t border-gray-500/20 dark:border-gray-400/20 pt-4">
                            {/* Template Details */}
                            <div className="space-y-3">
                              <div>
                                <Label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Base Template</Label>
                                <div className="p-3 bg-gray-500/5 dark:bg-gray-400/5 rounded border border-gray-500/10 dark:border-gray-400/10 space-y-2 text-sm">
                                  <div>
                                    <span className="text-gray-500 dark:text-gray-400">System Prompt: </span>
                                    <span className="text-gray-900 dark:text-white text-xs">{agentTemplate.system_prompt.substring(0, 100)}...</span>
                                  </div>
                                  <div>
                                    <span className="text-gray-500 dark:text-gray-400">Model: </span>
                                    <span className="text-gray-900 dark:text-white">{agentTemplate.model}</span>
                                  </div>
                                  <div>
                                    <span className="text-gray-500 dark:text-gray-400">Base Tools: </span>
                                    <span className="text-gray-900 dark:text-white">{agentTemplate.tools.join(", ") || "None"}</span>
                                  </div>
                                  {Object.keys(agentTemplate.standards || {}).length > 0 && (
                                    <div>
                                      <span className="text-gray-500 dark:text-gray-400">Base Standards: </span>
                                      <span className="text-gray-900 dark:text-white font-mono text-xs">
                                        {JSON.stringify(agentTemplate.standards, null, 2)}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Override Tools Input */}
                              <div>
                                <Label htmlFor={`override-tools-${override.agent_template_id}`} className="mb-2 block">
                                  Additional Tools (comma-separated)
                                </Label>
                                <Textarea
                                  id={`override-tools-${override.agent_template_id}`}
                                  value={editingState.tools?.join(", ") || ""}
                                  onChange={(e) => {
                                    const tools = e.target.value
                                      .split(",")
                                      .map((t) => t.trim())
                                      .filter((t) => t.length > 0);
                                    setEditingOverrides((prev) => ({
                                      ...prev,
                                      [override.agent_template_id]: {
                                        ...editingState,
                                        tools: tools.length > 0 ? tools : null,
                                      },
                                    }));
                                  }}
                                  placeholder="e.g., Read, Write, Bash"
                                  className="font-mono text-sm min-h-[60px]"
                                />
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  Leave empty to use base template tools. Add tools to supplement the base template.
                                </p>
                              </div>

                              {/* Override Standards Input */}
                              <div>
                                <Label htmlFor={`override-standards-${override.agent_template_id}`} className="mb-2 block">
                                  Additional Standards (JSON)
                                </Label>
                                <Textarea
                                  id={`override-standards-${override.agent_template_id}`}
                                  value={editingState.standards ? JSON.stringify(editingState.standards, null, 2) : ""}
                                  onChange={(e) => {
                                    try {
                                      const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : null;
                                      setEditingOverrides((prev) => ({
                                        ...prev,
                                        [override.agent_template_id]: {
                                          ...editingState,
                                          standards: parsed,
                                        },
                                      }));
                                    } catch {
                                      // Invalid JSON, but allow typing
                                    }
                                  }}
                                  placeholder='{"key": "value"}'
                                  className="font-mono text-sm min-h-[120px]"
                                />
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                  Leave empty to use base template standards. Add standards to supplement the base template.
                                </p>
                              </div>

                              {/* Save Button */}
                              <div className="flex justify-end">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="cyan"
                                  onClick={() => {
                                    handleAgentOverrideSave(
                                      override.agent_template_id,
                                      editingState.tools,
                                      editingState.standards
                                    );
                                  }}
                                  disabled={isSubmitting}
                                >
                                  {isSubmitting ? (
                                    <>
                                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                      Saving...
                                    </>
                                  ) : (
                                    "Save Override"
                                  )}
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {agentOverrides.length === 0 && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">No agent overrides configured</p>
                  )}

                  {/* Add new override */}
                  <div className="p-4 bg-gray-500/10 dark:bg-gray-400/10 border border-gray-500/20 dark:border-gray-400/20 rounded-lg">
                    <Label className="mb-2 block">Add Agent Override</Label>
                    {!agentTemplates || agentTemplates.length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 py-2">
                        No agent templates available. Create agents in Context Hub first.
                      </p>
                    ) : (
                      <select
                        className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20 mb-3"
                        onChange={async (e) => {
                          const agentId = e.target.value;
                          if (agentId && !agentOverrides.find((o) => o.agent_template_id === agentId)) {
                            // Create override with null values initially
                            await handleAgentOverrideSave(agentId, null, null);
                            // Initialize editing state
                            setEditingOverrides((prev) => ({
                              ...prev,
                              [agentId]: { tools: null, standards: null },
                            }));
                            // Auto-expand the new override
                            setExpandedOverrides((prev) => new Set(prev).add(agentId));
                            // Reset select after save
                            e.target.value = "";
                          }
                        }}
                        disabled={isSubmitting}
                        value=""
                      >
                        <option value="">Select an agent...</option>
                        {agentTemplates
                          .filter((agent) => !agentOverrides.find((o) => o.agent_template_id === agent.id))
                          .map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name} ({agent.slug})
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 rounded p-3">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
                Close
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
