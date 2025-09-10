/**
 * Provider Form Component
 *
 * Handles API key configuration for selected provider
 */

import React from "react";
import {
  X,
  Key,
  Info,
  Brain,
  FileText,
  DollarSign,
  Zap,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "../../../../components/ui/Button";
import type { ProviderMetadata } from "../../../../types/cleanProvider";

interface ProviderFormProps {
  selectedProvider: string;
  selectedProviderMeta: ProviderMetadata | null;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  showApiKey: boolean;
  onToggleShowApiKey: () => void;
  onDeselectProvider: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  existingProviders: string[];
}

export const ProviderForm: React.FC<ProviderFormProps> = ({
  selectedProvider,
  selectedProviderMeta,
  apiKey,
  onApiKeyChange,
  showApiKey,
  onToggleShowApiKey,
  onDeselectProvider,
  onSubmit,
  isSubmitting,
  existingProviders,
}) => {
  // Generate provider display info from metadata or provider name
  const getProviderDisplayInfo = (
    provider: string,
    metadata?: ProviderMetadata
  ) => {
    return {
      name: metadata
        ? provider.charAt(0).toUpperCase() + provider.slice(1)
        : provider.charAt(0).toUpperCase() + provider.slice(1),
      icon: "🤖", // Default icon, will use metadata if available
      color: "text-gray-400", // Default color
      apiKeyPlaceholder:
        provider === "ollama" ? "http://localhost:11434" : "Enter API key",
    };
  };

  const info = getProviderDisplayInfo(
    selectedProvider,
    selectedProviderMeta || undefined
  );
  const isUpdate = existingProviders.includes(selectedProvider);

  return (
    <div className="space-y-4">
      {/* Selected Provider Header */}
      <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{info.icon}</span>
          <div>
            <h3 className={`font-medium ${info.color}`}>{info.name}</h3>
            {selectedProviderMeta && (
              <div className="space-y-1">
                <p className="text-xs text-gray-400">
                  {selectedProviderMeta.model_count} models available
                </p>
                <div className="flex items-center gap-2 text-xs">
                  {selectedProviderMeta.has_free_models && (
                    <span className="text-emerald-400">Free tier</span>
                  )}
                  {selectedProviderMeta.max_context_length > 0 && (
                    <span className="text-blue-400">
                      Max{" "}
                      {Math.floor(
                        selectedProviderMeta.max_context_length / 1000
                      )}
                      K context
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <button
          onClick={onDeselectProvider}
          className="text-gray-400 hover:text-white"
          title="Change provider selection"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* API Key Input */}
      <div>
        <label
          htmlFor="provider-secret"
          className="block text-sm font-medium text-gray-300 mb-2"
        >
          {selectedProvider === "ollama" ? "Base URL" : "API Key"}
        </label>
        <div className="relative">
          <Key
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            aria-hidden="true"
          />
          <input
            id="provider-secret"
            type={
              selectedProvider === "ollama"
                ? "text"
                : showApiKey
                ? "text"
                : "password"
            }
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={info.apiKeyPlaceholder}
            autoComplete="off"
            className="w-full pl-10 pr-10 py-2 text-sm bg-zinc-800 text-white rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          {selectedProvider !== "ollama" && (
            <button
              type="button"
              onClick={onToggleShowApiKey}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
              title={showApiKey ? "Hide API key" : "Show API key"}
            >
              {showApiKey ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Info Box */}
      <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <div className="flex gap-2">
          <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-gray-300 space-y-1">
            <p>
              Your API key will be stored securely and never exposed in the UI.
            </p>
            {selectedProvider === "ollama" && (
              <p>
                For Ollama, enter the base URL of your Ollama server (e.g.,
                http://localhost:11434).
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Features from Backend Metadata */}
      {selectedProviderMeta && (
        <div>
          <h4 className="text-xs font-medium text-gray-400 mb-2">
            Provider Details
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-zinc-900/50 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <Brain className="w-4 h-4 text-purple-400" />
                <span className="text-xs text-gray-400">Models</span>
              </div>
              <p className="text-sm text-white font-medium">
                {selectedProviderMeta.model_count}
              </p>
            </div>

            <div className="p-3 bg-zinc-900/50 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-blue-400" />
                <span className="text-xs text-gray-400">Max Context</span>
              </div>
              <p className="text-sm text-white font-medium">
                {Math.floor(selectedProviderMeta.max_context_length / 1000)}K
              </p>
            </div>

            {selectedProviderMeta.min_input_cost > 0 && (
              <div className="p-3 bg-zinc-900/50 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <DollarSign className="w-4 h-4 text-green-400" />
                  <span className="text-xs text-gray-400">Cost Range</span>
                </div>
                <p className="text-sm text-white font-medium">
                  ${selectedProviderMeta.min_input_cost.toFixed(3)} - $
                  {selectedProviderMeta.max_input_cost.toFixed(2)}
                </p>
                <p className="text-xs text-gray-500">per 1M tokens</p>
              </div>
            )}

            <div className="p-3 bg-zinc-900/50 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-yellow-400" />
                <span className="text-xs text-gray-400">Capabilities</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {selectedProviderMeta.has_free_models && (
                  <span className="px-1.5 py-0.5 text-xs bg-emerald-900/30 text-emerald-400 rounded">
                    Free
                  </span>
                )}
                {selectedProviderMeta.supports_vision && (
                  <span className="px-1.5 py-0.5 text-xs bg-blue-900/30 text-blue-400 rounded">
                    Vision
                  </span>
                )}
                {selectedProviderMeta.supports_tools && (
                  <span className="px-1.5 py-0.5 text-xs bg-purple-900/30 text-purple-400 rounded">
                    Tools
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Top Models if available */}
          {selectedProviderMeta.top_models &&
            selectedProviderMeta.top_models.length > 0 && (
              <div className="mt-3">
                <h5 className="text-xs font-medium text-gray-400 mb-2">
                  Popular Models
                </h5>
                <div className="space-y-1">
                  {selectedProviderMeta.top_models
                    .slice(0, 3)
                    .map((model, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-gray-300">{model.model}</span>
                        <span className="text-gray-500">
                          ${model.input_cost.toFixed(4)}/1K
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
        </div>
      )}

      {/* Footer Actions */}
      <div className="flex justify-end gap-2 pt-4 border-t border-zinc-700">
        <Button
          onClick={onSubmit}
          variant="primary"
          size="sm"
          disabled={!apiKey.trim() || isSubmitting}
        >
          {isSubmitting
            ? "Saving..."
            : isUpdate
            ? "Update Provider"
            : "Add Provider"}
        </Button>
      </div>
    </div>
  );
};
