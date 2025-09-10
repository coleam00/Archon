/**
 * Advanced Settings Component
 *
 * Temperature and max tokens configuration sliders
 */

import React from "react";
import { Settings2, ChevronRight } from "lucide-react";
import type { AgentConfig } from "@/types/agent";
import { getRangeSliderStyle } from "@/features/agents/components/common/styles/gradientStyles";

interface AdvancedSettingsProps {
  agent: AgentConfig;
  temperature: number;
  maxTokens: number;
  onTemperatureChange: (value: number) => void;
  onMaxTokensChange: (value: number) => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}

export const AdvancedSettings: React.FC<AdvancedSettingsProps> = ({
  agent,
  temperature,
  maxTokens,
  onTemperatureChange,
  onMaxTokensChange,
  isExpanded,
  onToggleExpanded,
}) => {
  if (!agent.supportsTemperature && !agent.supportsMaxTokens) {
    return null;
  }

  return (
    <div className="mt-4 pt-4 border-t border-zinc-700">
      <button
        onClick={onToggleExpanded}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <Settings2 className="w-4 h-4" />
        Advanced Settings
        <ChevronRight
          className={`w-4 h-4 transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-4">
          {agent.supportsTemperature && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">
                Temperature: <span className="text-white">{temperature}</span>
              </label>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={temperature}
                onChange={(e) => {
                  const parsedValue = parseFloat(e.target.value);
                  const min = 0;
                  const max = 2;
                  const clampedValue = isFinite(parsedValue)
                    ? Math.min(Math.max(parsedValue, min), max)
                    : min;
                  onTemperatureChange(clampedValue);
                }}
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                style={getRangeSliderStyle(temperature, 2)}
              />
              <div className="flex justify-between text-xs text-gray-600 mt-1">
                <span>Precise</span>
                <span>Balanced</span>
                <span>Creative</span>
              </div>
            </div>
          )}

          {agent.supportsMaxTokens && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-2">
                Max Tokens: <span className="text-white">{maxTokens}</span>
              </label>
              <input
                type="range"
                min="100"
                max="4000"
                step="100"
                value={maxTokens}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10);
                  if (!isNaN(value) && value >= 100 && value <= 4000) {
                    onMaxTokensChange(value);
                  }
                }}
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                style={getRangeSliderStyle(maxTokens, 4000)}
              />
              <div className="flex justify-between text-xs text-gray-600 mt-1">
                <span>Short</span>
                <span>Medium</span>
                <span>Long</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
