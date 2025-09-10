/**
 * Provider Card Component
 *
 * Individual provider configuration card with API key management
 * Styled to match the existing AgentCard UI patterns
 */

import React, { useState } from "react";
import {
  X,
  Loader2,
  Eye,
  EyeOff,
  TestTube,
  Plus,
  Save,
  Wrench,
} from "lucide-react";
import type {
  ProviderType,
  ProviderStatus,
} from "../../../../types/cleanProvider";
import { getProviderIcon, getProviderDisplayName } from "../common";
import { GradientCard } from "../common/ui-primitives/GradientCard";
import { getThemeForState } from "../common/styles/gradientStyles";

interface ProviderCardProps {
  provider: ProviderStatus;
  metadata?: any;
  onSave: (
    provider: ProviderType,
    apiKey: string,
    baseUrl?: string
  ) => Promise<void>;
  onTest: (provider: ProviderType) => Promise<void>;
  onRemove: (provider: ProviderType) => Promise<void>;
  isSaving?: boolean;
  isTesting?: boolean;
  isRemoving?: boolean;
}

export const ProviderCard: React.FC<ProviderCardProps> = ({
  provider,
  metadata,
  onSave,
  onTest,
  onRemove,
  isSaving = false,
  isTesting = false,
  isRemoving = false,
}) => {
  // Consolidated state management
  const [state, setState] = useState({
    apiKey: "",
    baseUrl: "",
    showKey: false,
    showInput: !provider.configured,
  });

  const handleSave = async () => {
    if (!state.apiKey && provider.provider !== "ollama") {
      return;
    }

    try {
      if (provider.provider === "ollama") {
        await onSave(provider.provider, "", state.baseUrl || undefined);
      } else {
        await onSave(
          provider.provider,
          state.apiKey,
          state.baseUrl || undefined
        );
      }
      setState((prev) => ({ ...prev, showInput: false }));
    } catch (error) {
      // Error is handled by parent
    }
  };

  const handleTest = async () => {
    try {
      await onTest(provider.provider);
    } catch (error) {
      // Error is handled by parent
    }
  };

  const handleRemove = async () => {
    try {
      await onRemove(provider.provider);
    } catch (error) {
      // Error is handled by parent
    }
  };

  const isConfigured = provider.configured;

  // Compact status display
  const getStatusDisplay = () => {
    const statusMap = {
      healthy: { text: "✓", color: "text-emerald-400" },
      degraded: { text: "⚠", color: "text-yellow-400" },
      error: { text: "✗", color: "text-red-400" },
      not_configured: { text: "○", color: "text-gray-500" },
      unknown: { text: "?", color: "text-gray-500" },
    };
    const status = statusMap[provider.health] || statusMap.unknown;
    return (
      <span className={`${status.color} text-xs font-mono`}>{status.text}</span>
    );
  };

  // Compact metadata display
  const getMetadataDisplay = () => {
    if (!metadata) return null;
    const parts = [];
    if (metadata.model_count > 0) parts.push(`${metadata.model_count}M`);
    if (metadata.max_context_length > 0) {
      const tokens =
        metadata.max_context_length >= 1000000
          ? `${Math.floor(metadata.max_context_length / 1000000)}M`
          : metadata.max_context_length >= 1000
          ? `${Math.floor(metadata.max_context_length / 1000)}K`
          : metadata.max_context_length;
      parts.push(`${tokens}T`);
    }
    if (metadata.has_free_models) parts.push("Free");
    if (metadata.min_input_cost > 0) {
      const cost =
        metadata.min_input_cost < 1
          ? metadata.min_input_cost.toFixed(3)
          : metadata.min_input_cost.toFixed(2);
      parts.push(`$${cost}`);
    }
    return parts.length > 0 ? (
      <span className="text-xs text-gray-500 font-mono">
        {parts.join(" • ")}
      </span>
    ) : null;
  };

  return (
    <GradientCard
      theme={getThemeForState(
        isConfigured,
        provider.health === "error",
        provider.health === "degraded"
      )}
      isActive={isConfigured}
      isHoverable={true}
      onClick={undefined}
      size="sm"
    >
      <div className="relative p-3">
        {/* Compact Header - Horizontal Layout */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            {/* Icon */}
            <div className="text-lg flex-shrink-0">
              {getProviderIcon(provider.provider)}
            </div>

            {/* Title and Status */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-white truncate">
                  {getProviderDisplayName(provider.provider)}
                </h4>
                {getStatusDisplay()}
                {isConfigured && (
                  <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full flex-shrink-0" />
                )}
              </div>

              {/* Compact metadata line */}
              <div className="flex items-center gap-2 mt-0.5">
                {getMetadataDisplay()}
              </div>
            </div>
          </div>

          {/* Compact Action Buttons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {isConfigured ? (
              <>
                <button
                  onClick={handleTest}
                  disabled={isTesting}
                  className="p-1 text-gray-400 hover:text-white hover:bg-zinc-700/50 rounded transition-colors"
                  title="Test connection"
                >
                  {isTesting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <TestTube className="w-3 h-3" />
                  )}
                </button>

                <button
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      showInput: !prev.showInput,
                    }))
                  }
                  className="p-1 text-gray-400 hover:text-white hover:bg-zinc-700/50 rounded transition-colors"
                  title="Edit configuration"
                >
                  <Wrench className="w-3 h-3" />
                </button>

                <button
                  onClick={handleRemove}
                  disabled={isRemoving}
                  className="p-1 text-red-400 hover:text-red-300 hover:bg-zinc-700/50 rounded transition-colors"
                  title="Remove provider"
                >
                  {isRemoving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </button>
              </>
            ) : !state.showInput ? (
              <button
                onClick={() =>
                  setState((prev) => ({ ...prev, showInput: true }))
                }
                className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Setup
              </button>
            ) : null}
          </div>
        </div>

        {/* Compact Configuration Form */}
        {state.showInput && (
          <div className="mt-3 pt-3 border-t border-zinc-700/30">
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <input
                    type={
                      provider.provider === "ollama" || state.showKey
                        ? "text"
                        : "password"
                    }
                    value={state.apiKey}
                    onChange={(e) =>
                      setState((prev) => ({ ...prev, apiKey: e.target.value }))
                    }
                    placeholder={
                      provider.provider === "ollama"
                        ? "http://localhost:11434"
                        : "API Key"
                    }
                    className="w-full px-2 py-1.5 text-sm bg-zinc-800 text-white rounded border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                {provider.provider !== "ollama" && (
                  <button
                    onClick={() =>
                      setState((prev) => ({ ...prev, showKey: !prev.showKey }))
                    }
                    className="p-1.5 text-gray-400 hover:text-white border border-zinc-700 rounded"
                    title={state.showKey ? "Hide" : "Show"}
                  >
                    {state.showKey ? (
                      <EyeOff className="w-3 h-3" />
                    ) : (
                      <Eye className="w-3 h-3" />
                    )}
                  </button>
                )}
              </div>

              {provider.provider !== "ollama" && (
                <input
                  type="text"
                  value={state.baseUrl}
                  onChange={(e) =>
                    setState((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  placeholder="Base URL (optional)"
                  className="w-full px-2 py-1.5 text-sm bg-zinc-800 text-white rounded border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={
                    (!state.apiKey.trim() && provider.provider !== "ollama") ||
                    isSaving
                  }
                  className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded flex items-center gap-1 transition-colors"
                >
                  {isSaving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  Save
                </button>

                <button
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      showInput: false,
                      apiKey: "",
                      baseUrl: "",
                    }))
                  }
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-zinc-700 hover:border-zinc-600 rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </GradientCard>
  );
};
