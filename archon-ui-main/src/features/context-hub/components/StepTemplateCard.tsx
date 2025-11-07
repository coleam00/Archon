/**
 * Step Template Card Component
 *
 * Displays step template summary with type badge.
 */

import { useContextHubStore } from "../state/contextHubStore";
import type { StepTemplate } from "../types";
import { STEP_TYPE_CONFIGS } from "../types";

interface StepTemplateCardProps {
  template: StepTemplate;
}

const stepTypeColorClasses = {
  planning: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  implement: "bg-green-500/20 text-green-700 dark:text-green-300",
  validate: "bg-purple-500/20 text-purple-700 dark:text-purple-300",
  prime: "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300",
  git: "bg-gray-500/20 text-gray-700 dark:text-gray-300",
};

export function StepTemplateCard({ template }: StepTemplateCardProps) {
  const openEditModal = useContextHubStore((s) => s.openEditStepModal);
  const typeConfig = STEP_TYPE_CONFIGS[template.step_type];

  return (
    <div
      onClick={() => openEditModal(template.slug)}
      className="p-4 rounded-xl bg-gradient-to-br from-gray-100 to-gray-50 dark:from-gray-800 dark:to-gray-900 backdrop-blur-sm border border-gray-300 dark:border-gray-700 shadow-lg hover:shadow-xl transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-gray-900 dark:text-white truncate">{template.name}</h3>
        <span className={`text-xs px-2 py-1 rounded-full ${stepTypeColorClasses[template.step_type]}`}>
          {typeConfig.label}
        </span>
      </div>
      {template.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">{template.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-500">
        <span>v{template.version}</span>
        {template.sub_steps.length > 0 && (
          <>
            <span>•</span>
            <span>{template.sub_steps.length} sub-steps</span>
          </>
        )}
      </div>
    </div>
  );
}
