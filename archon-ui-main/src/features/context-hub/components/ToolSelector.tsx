import { Check } from "lucide-react";
import type React from "react";
import { Button } from "@/features/ui/primitives/button";
import { Label } from "@/features/ui/primitives/label";
import { AVAILABLE_TOOLS } from "../types";

interface ToolSelectorProps {
  selectedTools: string[];
  onChange: (tools: string[]) => void;
  disabled?: boolean;
  label?: string;
}

export const ToolSelector: React.FC<ToolSelectorProps> = ({
  selectedTools,
  onChange,
  disabled = false,
  label = "Available Tools",
}) => {
  const toggleTool = (tool: string) => {
    if (disabled) return;

    if (selectedTools.includes(tool)) {
      onChange(selectedTools.filter((t) => t !== tool));
    } else {
      onChange([...selectedTools, tool]);
    }
  };

  const selectAll = () => {
    if (disabled) return;
    onChange([...AVAILABLE_TOOLS]);
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={selectAll} disabled={disabled}>
            Select All
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={clearAll} disabled={disabled}>
            Clear
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {AVAILABLE_TOOLS.map((tool) => {
          const isSelected = selectedTools.includes(tool);

          return (
            <button
              key={tool}
              type="button"
              onClick={() => toggleTool(tool)}
              disabled={disabled}
              className={`
                relative px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200
                ${
                  isSelected
                    ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-700 dark:text-cyan-300 shadow-sm"
                    : "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-cyan-500/30"
                }
                border ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:scale-105"}
              `}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{tool}</span>
                {isSelected && <Check className="w-4 h-4 flex-shrink-0 text-cyan-600 dark:text-cyan-400" />}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        {selectedTools.length} / {AVAILABLE_TOOLS.length} tools selected
      </p>
    </div>
  );
};
