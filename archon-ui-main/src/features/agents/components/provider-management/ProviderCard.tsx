/**
 * Provider Card Component
 *
 * Individual provider configuration card with API key management
 * Styled to match the existing AgentCard UI patterns
 */

import React, { useState } from "react";
import {
  Key,
  X,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  TestTube,
  Plus,
  CheckCircle,
  XCircle,
  Clock,
  Save,
  Wrench,
} from "lucide-react";
import { Button } from "../../../../components/ui/Button";
import type {
  ProviderType,
  ProviderStatus,
} from "../../../../types/cleanProvider";
import { getProviderIcon, getProviderDisplayName } from "../common";

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
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showInput, setShowInput] = useState(!provider.configured);

  const getStatusIcon = (health: ProviderStatus["health"]) => {
    switch (health) {
      case "healthy":
        return <CheckCircle className="w-3 h-3 text-emerald-400" />;
      case "degraded":
        return <Clock className="w-3 h-3 text-yellow-500" />;
      case "error":
        return <XCircle className="w-3 h-3 text-red-500" />;
      default:
        return <AlertCircle className="w-3 h-3 text-gray-500" />;
    }
  };

  const handleSave = async () => {
    if (!apiKey && provider.provider !== "ollama") {
      return;
    }

    try {
      if (provider.provider === "ollama") {
        await onSave(provider.provider, "", baseUrl || undefined);
      } else {
        await onSave(provider.provider, apiKey, baseUrl || undefined);
      }
      setShowInput(false);
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

  return (
    <div
      className={`relative rounded-xl transition-all duration-300 hover:scale-[1.002] ${
        isConfigured ? "hover:shadow-lg" : ""
      }`}
      style={{
        background: isConfigured
          ? "linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)"
          : "linear-gradient(135deg, rgba(15, 18, 30, 0.7) 0%, rgba(10, 12, 20, 0.8) 100%)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Animated status bar for configured providers */}
      {isConfigured && provider.health === "healthy" && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500 animate-pulse" />
      )}

      {/* Border gradient */}
      <div
        className="absolute inset-0 rounded-xl p-[1px] pointer-events-none"
        style={{
          background: isConfigured
            ? "linear-gradient(180deg, rgba(168, 85, 247, 0.3) 0%, rgba(59, 130, 246, 0.2) 100%)"
            : "linear-gradient(180deg, rgba(100, 100, 100, 0.1) 0%, rgba(50, 50, 50, 0.05) 100%)",
        }}
      >
        <div
          className="w-full h-full rounded-xl"
          style={{
            background: isConfigured
              ? "linear-gradient(135deg, rgba(20, 25, 40, 0.9) 0%, rgba(15, 20, 35, 0.95) 100%)"
              : "linear-gradient(135deg, rgba(15, 18, 30, 0.7) 0%, rgba(10, 12, 20, 0.8) 100%)",
          }}
        />
      </div>

      <div className="relative p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-start gap-3">
            <div className="text-2xl mt-1">
              {getProviderIcon(provider.provider)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-light text-white">
                  {getProviderDisplayName(provider.provider)}
                </h4>
                {provider.configured && (
                  <span className="px-2 py-0.5 text-xs rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Active
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                {getStatusIcon(provider.health)}
                {provider.health === "healthy"
                  ? "Connected"
                  : provider.health === "degraded"
                  ? "Issues detected"
                  : provider.health === "error"
                  ? "Connection failed"
                  : "Not configured"}
              </p>
              {metadata && (
                <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                  {metadata.model_count > 0 && (
                    <span title="Available models">
                      {metadata.model_count} models
                    </span>
                  )}
                  {metadata.max_context_length > 0 && (
                    <span title="Maximum context length">
                      {metadata.max_context_length >= 1000000
                        ? `${Math.floor(
                            metadata.max_context_length / 1000000
                          )}M`
                        : metadata.max_context_length >= 1000
                        ? `${Math.floor(metadata.max_context_length / 1000)}K`
                        : metadata.max_context_length}{" "}
                      tokens
                    </span>
                  )}
                  {metadata.has_free_models && (
                    <span className="text-emerald-400" title="Has free models">
                      Free tier
                    </span>
                  )}
                  {metadata.min_input_cost > 0 && (
                    <span title="Cost range per 1M input tokens">
                      $
                      {metadata.min_input_cost < 1
                        ? metadata.min_input_cost.toFixed(3)
                        : metadata.min_input_cost.toFixed(2)}
                      {metadata.max_input_cost !== metadata.min_input_cost
                        ? `-$${
                            metadata.max_input_cost < 1
                              ? metadata.max_input_cost.toFixed(3)
                              : metadata.max_input_cost.toFixed(2)
                          }`
                        : ""}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {isConfigured && (
              <>
                <Button
                  onClick={handleTest}
                  variant="ghost"
                  size="sm"
                  disabled={isTesting}
                  className="p-1.5 min-w-0 h-auto"
                  title="Test connection"
                >
                  {isTesting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <TestTube className="w-3 h-3" />
                  )}
                </Button>

                <Button
                  onClick={() => setShowInput(!showInput)}
                  variant="ghost"
                  size="sm"
                  className="p-1.5 min-w-0 h-auto"
                  title="Edit configuration"
                >
                  <Wrench className="w-3 h-3" />
                </Button>

                <Button
                  onClick={handleRemove}
                  variant="ghost"
                  size="sm"
                  disabled={isRemoving}
                  className="p-1.5 min-w-0 h-auto text-red-400 hover:text-red-300"
                  title="Remove provider"
                >
                  {isRemoving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </Button>
              </>
            )}

            {!isConfigured && !showInput && (
              <Button
                onClick={() => setShowInput(true)}
                variant="secondary"
                size="sm"
                className="gap-1.5 text-xs"
              >
                <Plus className="w-3 h-3" />
                Configure
              </Button>
            )}
          </div>
        </div>

        {/* Configuration Input */}
        {showInput && (
          <div className="space-y-3 pt-3 border-t border-zinc-700/50">
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-300">
                {provider.provider === "ollama" ? "Base URL" : "API Key"}
              </label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type={
                    provider.provider === "ollama" || showKey
                      ? "text"
                      : "password"
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    provider.provider === "ollama"
                      ? "http://localhost:11434"
                      : "Enter API key"
                  }
                  className="w-full pl-10 pr-10 py-2 text-sm bg-zinc-800 text-white rounded-lg border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                {provider.provider !== "ollama" && (
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                    title={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                )}
              </div>
            </div>

            {/* Additional URL field for certain providers */}
            {provider.provider !== "ollama" && (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-300">
                  Base URL (optional)
                </label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.example.com"
                  className="w-full px-3 py-2 text-sm bg-zinc-800 text-white rounded-lg border border-zinc-700 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleSave}
                variant="primary"
                size="sm"
                disabled={!apiKey.trim() || isSaving}
                className="gap-1.5"
              >
                {isSaving ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Save className="w-3 h-3" />
                )}
                Save
              </Button>

              <Button
                onClick={() => {
                  setShowInput(false);
                  setApiKey("");
                  setBaseUrl("");
                }}
                variant="ghost"
                size="sm"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
