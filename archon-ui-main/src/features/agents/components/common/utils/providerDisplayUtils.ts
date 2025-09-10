/**
 * Provider Display Utilities
 *
 * Centralized functions for generating provider display information
 * and metadata handling across agent components
 */

import type { ProviderMetadata } from "../../../../../types/cleanProvider";

export interface ProviderDisplayInfo {
  name: string;
  icon: string;
  color: string;
  description: string;
  apiKeyPlaceholder: string;
}

/**
 * Generate consistent provider display information
 */
export const getProviderDisplayInfo = (
  provider: string,
  metadata?: ProviderMetadata
): ProviderDisplayInfo => {
  return {
    name: metadata
      ? provider.charAt(0).toUpperCase() + provider.slice(1)
      : provider.charAt(0).toUpperCase() + provider.slice(1),
    icon: "🤖", // Default icon, can be enhanced with provider-specific icons
    color: "text-gray-400", // Default color
    description: metadata
      ? `${metadata.model_count} models available${
          metadata.has_free_models ? " • Free tier available" : ""
        }`
      : `Provider with models available`,
    apiKeyPlaceholder:
      provider === "ollama" ? "http://localhost:11434" : "Enter API key",
  };
};

/**
 * Get provider-specific icon for better visual identification
 */
export const getProviderIcon = (provider: string): string => {
  const iconMap: Record<string, string> = {
    openai: "🟢",
    anthropic: "🔵",
    google: "🔴",
    ollama: "🦙",
    groq: "⚡",
    mistral: "🌟",
    cohere: "💫",
    huggingface: "🤗",
    together: "🤝",
    fireworks: "🎆",
    perplexity: "🔍",
    openrouter: "🔀",
  };

  return iconMap[provider.toLowerCase()] || "🤖";
};

/**
 * Get provider display name with proper formatting
 */
export const getProviderDisplayName = (provider: string): string => {
  const nameMap: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google AI",
    ollama: "Ollama",
    groq: "Groq",
    mistral: "Mistral AI",
    cohere: "Cohere",
    huggingface: "Hugging Face",
    together: "Together AI",
    fireworks: "Fireworks AI",
    perplexity: "Perplexity",
    openrouter: "OpenRouter",
  };

  return (
    nameMap[provider.toLowerCase()] ||
    provider.charAt(0).toUpperCase() + provider.slice(1)
  );
};

/**
 * Format provider metadata for display
 */
export const formatProviderMetadata = (metadata: ProviderMetadata) => {
  return {
    modelCount:
      typeof metadata.model_count === "number" && isFinite(metadata.model_count)
        ? metadata.model_count
        : null,
    maxContext:
      typeof metadata.max_context_length === "number" &&
      isFinite(metadata.max_context_length) &&
      metadata.max_context_length > 0
        ? metadata.max_context_length >= 1000000
          ? `${Math.floor(metadata.max_context_length / 1000000)}M`
          : metadata.max_context_length >= 1000
          ? `${Math.floor(metadata.max_context_length / 1000)}K`
          : metadata.max_context_length
        : null,
    costRange:
      typeof metadata.min_input_cost === "number" &&
      isFinite(metadata.min_input_cost) &&
      metadata.min_input_cost > 0
        ? {
            min:
              metadata.min_input_cost < 1
                ? metadata.min_input_cost.toFixed(3)
                : metadata.min_input_cost.toFixed(2),
            max:
              typeof metadata.max_input_cost === "number" &&
              isFinite(metadata.max_input_cost) &&
              metadata.max_input_cost !== metadata.min_input_cost
                ? metadata.max_input_cost < 1
                  ? metadata.max_input_cost.toFixed(3)
                  : metadata.max_input_cost.toFixed(2)
                : null,
          }
        : null,
    features: {
      hasFreeTier: !!metadata.has_free_models,
      supportsVision: !!metadata.supports_vision,
      supportsTools: !!metadata.supports_tools,
    },
  };
};
