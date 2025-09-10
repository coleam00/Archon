/**
 * Model Selection Utilities
 *
 * Utility functions for model selection, filtering, and display
 */

import type { AvailableModel } from "../../../../types/cleanProvider";
import type { AgentConfig } from "../../../../types/agent";

// Provider display information
export const getProviderInfo = (provider: string) => {
  const info: Record<string, { name: string; color: string; icon: string }> = {
    openai: { name: "OpenAI", color: "text-emerald-400", icon: "🤖" },
    anthropic: { name: "Anthropic", color: "text-blue-400", icon: "🧠" },
    google: { name: "Google", color: "text-yellow-400", icon: "🔍" },
    mistral: { name: "Mistral", color: "text-purple-400", icon: "🌊" },
    meta: { name: "Meta", color: "text-blue-500", icon: "🔷" },
    groq: { name: "Groq", color: "text-orange-400", icon: "⚡" },
    deepseek: { name: "DeepSeek", color: "text-cyan-400", icon: "🔬" },
    ollama: { name: "Ollama", color: "text-gray-400", icon: "🦙" },
    openrouter: { name: "OpenRouter", color: "text-pink-400", icon: "🌍" },
    cohere: { name: "Cohere", color: "text-indigo-400", icon: "🌐" },
    xai: { name: "xAI", color: "text-red-400", icon: "✖️" },
  };

  return (
    info[provider.toLowerCase()] || {
      name: provider.charAt(0).toUpperCase() + provider.slice(1),
      color: "text-gray-400",
      icon: "🤖",
    }
  );
};

// Cost tier display information
export const getCostTierInfo = (tier?: string | null) => {
  switch (tier) {
    case "free":
      return {
        label: "Free",
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/10",
      };
    case "low":
      return { label: "$", color: "text-blue-400", bgColor: "bg-blue-500/10" };
    case "medium":
      return {
        label: "$$",
        color: "text-yellow-400",
        bgColor: "bg-yellow-500/10",
      };
    case "high":
      return {
        label: "$$$",
        color: "text-orange-400",
        bgColor: "bg-orange-500/10",
      };
    default:
      return { label: "", color: "text-gray-400", bgColor: "" };
  }
};

// Format single cost value per 1M tokens
export const formatSingleCost = (costPer1M: number) => {
  // Cost is already per 1M tokens, no conversion needed
  const costPer1MFormatted = costPer1M;

  // Format based on the cost magnitude with dollar sign after
  if (costPer1MFormatted === 0) return "0$";
  if (costPer1MFormatted < 0.01) return `${costPer1MFormatted.toFixed(4)}$`;
  if (costPer1MFormatted < 1) return `${costPer1MFormatted.toFixed(2)}$`;
  if (costPer1MFormatted < 10) return `${costPer1MFormatted.toFixed(1)}$`;
  return `${Math.round(costPer1MFormatted)}$`;
};

// Filter and sort models based on criteria
export const filterAndSortModels = (
  models: AvailableModel[],
  searchQuery: string,
  filterProvider: string,
  filterCostTier: string,
  agent?: AgentConfig
) => {
  let filtered = [...models];

  // Filter compatible models if agent type specified
  if (agent?.modelType === "embedding") {
    // Use the is_embedding flag if available, otherwise fall back to string check
    filtered = filtered.filter(
      (m) => m.is_embedding || m.model_string.includes("embedding")
    );
  } else if (agent) {
    // For LLM models, exclude embedding models
    filtered = filtered.filter(
      (m) => !m.is_embedding && !m.model_string.includes("embedding")
    );
  }

  // Search filter
  if (searchQuery) {
    const query = searchQuery.toLowerCase();
    filtered = filtered.filter(
      (m) =>
        m.display_name.toLowerCase().includes(query) ||
        m.model.toLowerCase().includes(query) ||
        m.provider.toLowerCase().includes(query)
    );
  }

  // Provider filter
  if (filterProvider !== "all") {
    filtered = filtered.filter((m) => m.provider === filterProvider);
  }

  // Cost tier filter
  if (filterCostTier !== "all") {
    filtered = filtered.filter((m) => m.cost_tier === filterCostTier);
  }

  // Sort by cost tier then name
  filtered.sort((a, b) => {
    if (a.cost_tier === "free" && b.cost_tier !== "free") return -1;
    if (a.cost_tier !== "free" && b.cost_tier === "free") return 1;

    const tierOrder = { low: 1, medium: 2, high: 3 };
    const aTier = tierOrder[a.cost_tier as keyof typeof tierOrder] || 4;
    const bTier = tierOrder[b.cost_tier as keyof typeof tierOrder] || 4;
    if (aTier !== bTier) return aTier - bTier;

    return a.display_name.localeCompare(b.display_name);
  });

  return filtered;
};

// Group models by provider
export const groupModelsByProvider = (models: AvailableModel[]) => {
  const grouped: Record<string, AvailableModel[]> = {};
  models.forEach((model) => {
    if (!grouped[model.provider]) {
      grouped[model.provider] = [];
    }
    grouped[model.provider].push(model);
  });
  return grouped;
};

// Get unique providers from models
export const getUniqueProviders = (models: AvailableModel[]) => {
  const providers = new Set(models.map((m) => m.provider));
  return Array.from(providers).sort();
};

// Get unique cost tiers from models
export const getUniqueCostTiers = (models: AvailableModel[]) => {
  const tiers = new Set(models.map((m) => m.cost_tier).filter(Boolean));
  return Array.from(tiers);
};
