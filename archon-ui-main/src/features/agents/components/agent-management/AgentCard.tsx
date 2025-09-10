/**
 * Agent Card Component
 *
 * Displays an agent/service with model configuration options
 * Styled to match the existing EnhancedProviderCard UI patterns
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
import { Clock, CheckCircle, XCircle } from "lucide-react";
import { useToast } from "../../../../contexts/ToastContext";
import type { AgentConfig } from "../../../../types/agent";
import type {
  AvailableModel,
  ModelConfig,
  ServiceType,
} from "../../../../types/cleanProvider";
import { Badge } from "../../../../components/ui/Badge";
import { ModelSelectionModal } from "../model-selection/ModelSelectionModal";
import { useAgents } from "../../hooks";
import { AgentModelPanel } from "./AgentModelPanel";
import { AgentSettingsDropdown } from "./AgentSettingsDropdown";
import { GradientCard } from "../common/ui-primitives/GradientCard";
import { getThemeForState } from "../common/styles/gradientStyles";

interface AgentCardProps {
  agent: AgentConfig;
  availableModels: AvailableModel[];
  currentConfig?: {
    model_string: string;
    temperature?: number;
    max_tokens?: number;
  };
}

// Valid ServiceType values for validation
const VALID_SERVICE_TYPES: ServiceType[] = [
  "document_agent",
  "rag_agent",
  "task_agent",
  "embeddings",
  "contextual_embedding",
  "source_summary",
  "code_summary",
  "code_analysis",
  "validation",
];

// Utility function to safely cast to ServiceType
const validateServiceType = (id: string): ServiceType => {
  if (VALID_SERVICE_TYPES.includes(id as ServiceType)) {
    return id as ServiceType;
  }
  console.warn(`Invalid service type: ${id}, defaulting to 'document_agent'`);
  return "document_agent";
};

export const AgentCard: React.FC<AgentCardProps> = React.memo(
  ({ agent, availableModels, currentConfig }) => {
    // Consolidated state management
    const [state, setState] = useState({
      isModalOpen: false,
      selectedModel: currentConfig?.model_string || agent.defaultModel,
      temperature: currentConfig?.temperature || 0.7,
      maxTokens: currentConfig?.max_tokens || 2000,
      isSaving: false,
      healthStatus: null as "healthy" | "unhealthy" | "checking" | null,
    });

    const { showToast } = useToast();
    const { handleConfigUpdate } = useAgents();
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync local state with props when they change
    useEffect(() => {
      if (currentConfig) {
        setState((prev) => ({
          ...prev,
          selectedModel: currentConfig.model_string,
          temperature: currentConfig.temperature ?? prev.temperature,
          maxTokens: currentConfig.max_tokens ?? prev.maxTokens,
        }));
      }
    }, [currentConfig]);

    // Cleanup timeouts on unmount
    useEffect(() => {
      return () => {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
      };
    }, []);

    // Filter models based on type (LLM vs embedding) - memoized for performance
    const compatibleModels = useMemo(() => {
      return availableModels.filter((m) => {
        if (agent.modelType === "embedding") {
          // Use the is_embedding flag if available, otherwise fall back to string check
          return m.is_embedding || m.model_string.includes("embedding");
        }
        // For LLM models, exclude embedding models
        return !m.is_embedding && !m.model_string.includes("embedding");
      });
    }, [availableModels, agent.modelType]);

    const handleModelSelect = async (
      model: AvailableModel,
      config?: { temperature?: number; maxTokens?: number }
    ) => {
      // Close modal immediately for better UX
      setState((prev) => ({ ...prev, isModalOpen: false }));

      // Store current state for potential rollback
      const previousState = {
        selectedModel: state.selectedModel,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
      };

      // Optimistically update the UI
      const newConfig: ModelConfig = {
        service_name: validateServiceType(agent.id),
        model_string: model.model_string,
        temperature: config?.temperature ?? state.temperature,
        max_tokens: config?.maxTokens ?? state.maxTokens,
      };

      // Update local state immediately
      setState((prev) => ({
        ...prev,
        selectedModel: model.model_string,
        temperature: config?.temperature ?? prev.temperature,
        maxTokens: config?.maxTokens ?? prev.maxTokens,
        isSaving: true,
        healthStatus: "checking",
      }));

      try {
        await handleConfigUpdate(validateServiceType(agent.id), newConfig);

        setState((prev) => ({ ...prev, healthStatus: "healthy" }));
        showToast(
          `${agent.name} configuration updated successfully`,
          "success"
        );

        // Clear status after success
        timeoutRef.current = setTimeout(() => {
          setState((prev) => ({ ...prev, healthStatus: null }));
          timeoutRef.current = null;
        }, 1500);
      } catch (error) {
        console.error("Failed to save agent config:", error);
        setState((prev) => ({ ...prev, healthStatus: "unhealthy" }));

        // Rollback to previous state
        setState((prev) => ({
          ...prev,
          selectedModel: previousState.selectedModel,
          temperature: previousState.temperature,
          maxTokens: previousState.maxTokens,
        }));

        showToast(
          `Failed to update ${agent.name} configuration. Please try again.`,
          "error"
        );

        // Clear error status after delay
        timeoutRef.current = setTimeout(() => {
          setState((prev) => ({ ...prev, healthStatus: null }));
          timeoutRef.current = null;
        }, 3000);
      } finally {
        setState((prev) => ({ ...prev, isSaving: false }));
      }
    };

    // Memoize computed values for performance
    const isModelAvailable = useMemo(() => {
      return compatibleModels.some(
        (m) => m.model_string === state.selectedModel
      );
    }, [compatibleModels, state.selectedModel]);

    const isActive = useMemo<boolean>(() => {
      return Boolean(currentConfig && isModelAvailable);
    }, [currentConfig, isModelAvailable]);

    // Memoize cost indicator to prevent unnecessary re-renders
    const costIndicator = useMemo(() => {
      const colors = {
        high: "text-red-400",
        medium: "text-yellow-400",
        low: "text-emerald-400",
      };
      const labels = { high: "$$$", medium: "$$", low: "$" };
      return (
        <span
          className={`text-xs font-mono ${
            colors[agent.costProfile as keyof typeof colors] || "text-gray-400"
          }`}
        >
          {labels[agent.costProfile as keyof typeof labels] || "$"}
        </span>
      );
    }, [agent.costProfile]);

    // Memoize status icon for better performance and accessibility
    const statusIcon = useMemo(() => {
      if (state.healthStatus === "checking") {
        return (
          <Clock
            className="w-3.5 h-3.5 text-yellow-400 animate-spin"
            aria-label="Saving configuration"
          />
        );
      }
      if (state.healthStatus === "healthy") {
        return (
          <CheckCircle
            className="w-3.5 h-3.5 text-emerald-400"
            aria-label="Configuration saved successfully"
          />
        );
      }
      if (state.healthStatus === "unhealthy") {
        return (
          <XCircle
            className="w-3.5 h-3.5 text-red-400"
            aria-label="Configuration save failed"
          />
        );
      }
      if (isModelAvailable) {
        return (
          <div
            className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"
            aria-label="Model available"
          />
        );
      }
      return (
        <div
          className="w-2 h-2 bg-gray-600 rounded-full"
          aria-label="Model unavailable"
        />
      );
    }, [state.healthStatus, isModelAvailable]);

    return (
      <GradientCard
        theme={getThemeForState(
          isActive,
          state.healthStatus === "unhealthy",
          false
        )}
        isActive={isActive}
        isHoverable={true}
        onClick={undefined}
        size="md"
        role="article"
        aria-labelledby={`agent-${agent.id}-title`}
        aria-describedby={`agent-${agent.id}-description`}
        className="animate-fadeInUp"
      >
        {/* Content */}
        <div className="relative">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              {/* Agent Icon */}
              <div className="w-10 h-10 rounded-lg bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                <span className="text-xl">{agent.icon}</span>
              </div>

              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3
                    className="text-sm font-light text-white"
                    id={`agent-${agent.id}-title`}
                  >
                    {agent.name}
                  </h3>
                  <Badge
                    variant={
                      agent.category === "agent" ? "primary" : "secondary"
                    }
                    className="text-xs px-1.5 py-0.5"
                  >
                    {agent.category}
                  </Badge>
                  {costIndicator}
                </div>
                <p
                  className="text-xs text-gray-500"
                  id={`agent-${agent.id}-description`}
                >
                  {agent.description}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">{statusIcon}</div>
          </div>

          <AgentModelPanel
            agent={agent}
            selectedModel={state.selectedModel}
            currentConfig={currentConfig}
            isModelAvailable={isModelAvailable}
          />
          <div className="flex items-center justify-end mt-3">
            <AgentSettingsDropdown
              agent={agent}
              isSaving={state.isSaving}
              onConfigure={() =>
                setState((prev) => ({ ...prev, isModalOpen: true }))
              }
            />
          </div>

          {/* Model Selection Modal */}
          <ModelSelectionModal
            isOpen={state.isModalOpen}
            onClose={() =>
              setState((prev) => ({ ...prev, isModalOpen: false }))
            }
            models={compatibleModels}
            currentModel={state.selectedModel}
            onSelectModel={handleModelSelect}
            agent={agent}
            showAdvancedSettings={true}
          />
        </div>
      </GradientCard>
    );
  }
);

AgentCard.displayName = "AgentCard";
