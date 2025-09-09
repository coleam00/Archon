/**
 * Advanced Settings Component
 *
 * Temperature and max tokens configuration sliders
 */

import React from "react";
import { Settings2, ChevronRight } from "lucide-react";
import type { AgentConfig } from "../../../../types/agent";

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
                onChange={(e) =>
                  onTemperatureChange(parseFloat(e.target.value))
                }
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${
                    temperature * 50
                  }%, #27272a ${temperature * 50}%, #27272a 100%)`,
                }}
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
                onChange={(e) => onMaxTokensChange(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, #7c3aed 0%, #7c3aed ${
                    (maxTokens / 4000) * 100
                  }%, #27272a ${(maxTokens / 4000) * 100}%, #27272a 100%)`,
                }}
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
