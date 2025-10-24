/**
 * CreateWorkOrderDialog Component
 *
 * Modal dialog for creating new agent work orders with form validation.
 * Includes repository URL, sandbox type, user request, and command selection.
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/features/ui/primitives/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/features/ui/primitives/dialog";
import { useCreateWorkOrder } from "../hooks/useAgentWorkOrderQueries";
import type { WorkflowStep } from "../types";

const workOrderSchema = z.object({
  repository_url: z.string().url("Must be a valid URL"),
  sandbox_type: z.enum(["git_branch", "git_worktree"]),
  user_request: z.string().min(10, "Request must be at least 10 characters"),
  github_issue_number: z.string().optional(),
});

type WorkOrderFormData = z.infer<typeof workOrderSchema>;

interface CreateWorkOrderDialogProps {
  /** Whether dialog is open */
  open: boolean;
  /** Callback when dialog should close */
  onClose: () => void;
  /** Callback when work order is created */
  onSuccess?: (workOrderId: string) => void;
}

const ALL_COMMANDS: WorkflowStep[] = ["create-branch", "planning", "execute", "commit", "create-pr"];

const COMMAND_LABELS: Record<WorkflowStep, string> = {
  "create-branch": "Create Branch",
  planning: "Planning",
  execute: "Execute",
  commit: "Commit",
  "create-pr": "Create PR",
  "prp-review": "PRP Review",
};

export function CreateWorkOrderDialog({ open, onClose, onSuccess }: CreateWorkOrderDialogProps) {
  const [selectedCommands, setSelectedCommands] = useState<WorkflowStep[]>(ALL_COMMANDS);
  const createWorkOrder = useCreateWorkOrder();
  const formId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<WorkOrderFormData>({
    resolver: zodResolver(workOrderSchema),
    defaultValues: {
      sandbox_type: "git_branch",
    },
  });

  const handleClose = () => {
    reset();
    setSelectedCommands(ALL_COMMANDS);
    onClose();
  };

  const onSubmit = async (data: WorkOrderFormData) => {
    createWorkOrder.mutate(
      {
        ...data,
        selected_commands: selectedCommands,
        github_issue_number: data.github_issue_number || null,
      },
      {
        onSuccess: (result) => {
          handleClose();
          onSuccess?.(result.agent_work_order_id);
        },
      },
    );
  };

  const toggleCommand = (command: WorkflowStep) => {
    setSelectedCommands((prev) => (prev.includes(command) ? prev.filter((c) => c !== command) : [...prev, command]));
  };

  const setPreset = (preset: "full" | "planning" | "no-pr") => {
    switch (preset) {
      case "full":
        setSelectedCommands(ALL_COMMANDS);
        break;
      case "planning":
        setSelectedCommands(["create-branch", "planning"]);
        break;
      case "no-pr":
        setSelectedCommands(["create-branch", "planning", "execute", "commit"]);
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create Agent Work Order</DialogTitle>
          <DialogDescription>Configure and launch a new AI-driven development workflow</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <div>
            <label htmlFor={`${formId}-repository_url`} className="block text-sm font-medium text-gray-300 mb-2">
              Repository URL *
            </label>
            <input
              id={`${formId}-repository_url`}
              type="text"
              {...register("repository_url")}
              placeholder="https://github.com/username/repo"
              className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            {errors.repository_url && <p className="mt-1 text-sm text-red-400">{errors.repository_url.message}</p>}
          </div>

          <div>
            <label htmlFor={`${formId}-sandbox_type`} className="block text-sm font-medium text-gray-300 mb-2">
              Sandbox Type *
            </label>
            <select
              id={`${formId}-sandbox_type`}
              {...register("sandbox_type")}
              className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
            >
              <option value="git_branch">Git Branch</option>
              <option value="git_worktree">Git Worktree</option>
            </select>
          </div>

          <div>
            <label htmlFor={`${formId}-user_request`} className="block text-sm font-medium text-gray-300 mb-2">
              User Request *
            </label>
            <textarea
              id={`${formId}-user_request`}
              {...register("user_request")}
              rows={4}
              placeholder="Describe the work you want the AI agent to perform..."
              className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
            />
            {errors.user_request && <p className="mt-1 text-sm text-red-400">{errors.user_request.message}</p>}
          </div>

          <div>
            <label htmlFor={`${formId}-github_issue_number`} className="block text-sm font-medium text-gray-300 mb-2">
              GitHub Issue Number (optional)
            </label>
            <input
              id={`${formId}-github_issue_number`}
              type="text"
              {...register("github_issue_number")}
              placeholder="123"
              className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-gray-300">Workflow Commands</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPreset("full")}
                  className="text-xs px-2 py-1 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                >
                  Full
                </button>
                <button
                  type="button"
                  onClick={() => setPreset("planning")}
                  className="text-xs px-2 py-1 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                >
                  Planning Only
                </button>
                <button
                  type="button"
                  onClick={() => setPreset("no-pr")}
                  className="text-xs px-2 py-1 bg-gray-700 text-gray-300 rounded hover:bg-gray-600"
                >
                  No PR
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {ALL_COMMANDS.map((command) => (
                <label
                  key={command}
                  className="flex items-center gap-3 p-3 bg-gray-800 border border-gray-700 rounded-lg hover:border-gray-600 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedCommands.includes(command)}
                    onChange={() => toggleCommand(command)}
                    className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                  />
                  <span className="text-gray-300">{COMMAND_LABELS[command]}</span>
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={handleClose} disabled={createWorkOrder.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={createWorkOrder.isPending || selectedCommands.length === 0}>
              {createWorkOrder.isPending ? "Creating..." : "Create Work Order"}
            </Button>
          </DialogFooter>
        </form>

        {createWorkOrder.isError && (
          <div className="mt-4 p-3 bg-red-900 bg-opacity-30 border border-red-700 rounded text-sm text-red-300">
            Failed to create work order. Please try again.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
