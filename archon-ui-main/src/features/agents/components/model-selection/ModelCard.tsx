/**
 * Model Card Component
 *
 * Displays individual model information with selection state
 */

import React from "react";
import { Check, AlertCircle } from "lucide-react";
import type { AvailableModel } from "../../../../types/cleanProvider";
import { getCostTierInfo, formatSingleCost } from "./modelSelectionUtils";
import { GradientCard } from "../common/ui-primitives/GradientCard";
import { Badge } from "../../../../components/ui/Badge";

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
    <GradientCard
      theme={isSelected ? "active" : "inactive"}
      isActive={isSelected}
      isHoverable={true}
      onClick={() => onSelect(model)}
      size="md"
      className="cursor-pointer"
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
            <Badge
              variant={
                model.cost_tier === "free"
                  ? "success"
                  : model.cost_tier === "low"
                  ? "primary"
                  : model.cost_tier === "medium"
                  ? "warning"
                  : model.cost_tier === "high"
                  ? "error"
                  : "secondary"
              }
              size="sm"
            >
              {getCostTierInfo(model.cost_tier).label}
            </Badge>
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
            <Badge
              variant="warning"
              size="sm"
              className="flex items-center gap-1"
            >
              <AlertCircle className="w-3 h-3" />
              No API Key
            </Badge>
          )}
        </div>
      </div>
    </GradientCard>
  );
};
