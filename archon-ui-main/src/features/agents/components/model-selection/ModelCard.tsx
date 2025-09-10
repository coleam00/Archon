/**
 * Model Card Component
 *
 * Displays individual model information with selection state
 */

import React from "react";
import { Check, AlertCircle } from "lucide-react";
import type { AvailableModel } from "../../../../types/cleanProvider";
import { getCostTierInfo, formatSingleCost } from "./modelSelectionUtils";

interface ModelCardProps {
  model: AvailableModel;
  isSelected: boolean;
  onSelect: (model: AvailableModel) => void;
}

export const ModelCard: React.FC<ModelCardProps> = ({
  model,
  isSelected,
  onSelect,
}) => {
  return (
    <div
      onClick={() => onSelect(model)}
      className={`
        relative p-4 rounded-lg border cursor-pointer transition-all
        ${
          isSelected
            ? "border-purple-500 bg-purple-500/10"
            : "border-zinc-700 hover:border-zinc-600 bg-zinc-800/50 hover:bg-zinc-800"
        }
      `}
    >
      {/* Selected Check */}
      {isSelected && (
        <div className="absolute top-3 right-3">
          <Check className="w-5 h-5 text-purple-400" />
        </div>
      )}

      {/* Model Info */}
      <div className="pr-8">
        <h4 className="text-sm font-medium text-white mb-1">
          {model.display_name}
        </h4>
        <p className="text-xs text-gray-500 font-mono mb-2">{model.model}</p>

        {/* Badges and Pricing on same line */}
        <div className="flex items-center gap-3 flex-wrap">
          {model.cost_tier && (
            <span
              className={`px-2 py-0.5 text-xs rounded ${
                getCostTierInfo(model.cost_tier).bgColor
              } ${getCostTierInfo(model.cost_tier).color}`}
            >
              {getCostTierInfo(model.cost_tier).label}
            </span>
          )}

          {/* Detailed Pricing - Input/Output inline */}
          {model.estimated_cost_per_1m && (
            <>
              <span className="text-xs text-gray-500">per 1M:</span>
              <span className="text-xs font-mono text-emerald-400">
                in {formatSingleCost(model.estimated_cost_per_1m.input)}
              </span>
              <span className="text-xs font-mono text-yellow-400">
                out {formatSingleCost(model.estimated_cost_per_1m.output)}
              </span>
            </>
          )}

          {!model.has_api_key && (
            <span className="px-2 py-0.5 text-xs bg-yellow-500/10 text-yellow-400 rounded flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              No API Key
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
