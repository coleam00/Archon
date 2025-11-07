/**
 * Workflow Template Card Component
 *
 * Displays workflow template summary.
 */

import { useContextHubStore } from "../state/contextHubStore";
import type { WorkflowTemplate } from "../types";

interface WorkflowTemplateCardProps {
  template: WorkflowTemplate;
}

export function WorkflowTemplateCard({ template }: WorkflowTemplateCardProps) {
  const openEditModal = useContextHubStore((s) => s.openEditWorkflowModal);
  const stepTypes = [...new Set(template.steps.map((s) => s.step_type))];

  return (
    <div
      onClick={() => openEditModal(template.slug)}
      className="p-4 rounded-xl bg-gradient-to-br from-purple-500/10 to-purple-600/5 backdrop-blur-sm border border-purple-500/20 shadow-lg hover:shadow-xl transition-shadow cursor-pointer"
    >
      <h3 className="font-semibold text-gray-900 dark:text-white truncate mb-2">{template.name}</h3>
      {template.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">{template.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-500">
        <span>{template.steps.length} steps</span>
        <span>•</span>
        <span>{stepTypes.join(", ")}</span>
      </div>
    </div>
  );
}
