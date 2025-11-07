/**
 * Agent Template Card Component
 *
 * Displays agent template summary in grid view.
 */

import { useContextHubStore } from "../state/contextHubStore";
import type { AgentTemplate } from "../types";

interface AgentTemplateCardProps {
  template: AgentTemplate;
}

export function AgentTemplateCard({ template }: AgentTemplateCardProps) {
  const openEditModal = useContextHubStore((s) => s.openEditAgentModal);

  return (
    <div
      onClick={() => openEditModal(template.slug)}
      className="p-4 rounded-xl bg-gradient-to-br from-indigo-500/10 to-indigo-600/5 backdrop-blur-sm border border-indigo-500/20 shadow-lg hover:shadow-xl transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between mb-2">
        <h3 className="font-semibold text-gray-900 dark:text-white truncate">{template.name}</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-indigo-500/20 text-indigo-700 dark:text-indigo-300">
          v{template.version}
        </span>
      </div>
      {template.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3">{template.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-500">
        <span>{template.model}</span>
        <span>•</span>
        <span>{template.tools.length} tools</span>
      </div>
    </div>
  );
}
