import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cpu,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Coins,
  Hash,
  Settings,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Activity,
  Zap,
  Clock,
  XCircle,
} from "lucide-react";
import { cleanProviderService } from "../services/cleanProviderService";
import { useServiceRegistry } from "../contexts/ServiceRegistryContext";
import { useAgents } from "../features/agents/hooks";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";

interface ActiveModel {
  model_string: string;
  provider: string;
  model: string;
  api_key_configured: boolean;
  is_default?: boolean;
}

interface ModelStatus {
  active_models: Record<string, ActiveModel>;
  api_key_status: Record<string, boolean>;
  usage?: {
    total_tokens_today: number;
    total_cost_today: number;
    estimated_monthly_cost: number;
  };
  timestamp: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-green-500",
  anthropic: "bg-orange-500",
  google: "bg-blue-500",
  mistral: "bg-purple-500",
  groq: "bg-pink-500",
  deepseek: "bg-indigo-500",
  ollama: "bg-gray-500",
  openrouter: "bg-teal-500",
  unknown: "bg-gray-400",
};

// Helper function to format large numbers
const formatTokens = (num: number): string => {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
};

// Helper function to format currency
const formatCurrency = (amount: number): string => {
  if (amount < 0.01) {
    return "$0.00";
  } else if (amount < 1) {
    return `$${amount.toFixed(3)}`;
  } else if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(2)}`;
};

export const ModelStatusBar: React.FC = () => {
  const navigate = useNavigate();

  // Debug navigation to prevent full page reloads
  const handleNavigate = useCallback(
    (path: string) => {
      // Ensure we're using client-side routing
      if (window.location.pathname !== path) {
        navigate(path, { replace: false });
      }
    },
    [navigate]
  );
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  const { getAgentConfigs, loading: servicesLoading } = useServiceRegistry();
  const { agents, backendServices } = useAgents();

  // Track window width for responsive behavior
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Memoize responsive values to prevent unnecessary re-renders
  const responsiveValues = useMemo(
    () => ({
      isMobile: windowWidth < 640,
      isTablet: windowWidth >= 640 && windowWidth < 768,
      isDesktop: windowWidth >= 768,
      maxServices: windowWidth < 640 ? 2 : 3,
      maxModels: windowWidth < 640 ? 1 : 2,
      showUsageStats: windowWidth >= 768,
      serviceNameLength: windowWidth < 640 ? 3 : undefined,
      modelNameLength: windowWidth < 640 ? 8 : 15,
    }),
    [windowWidth]
  );

  // Memoize agent configs to avoid calling getAgentConfigs() during render
  const agentConfigs = useMemo(() => getAgentConfigs(), [getAgentConfigs]);

  // Combine agents and backend services for display
  const allServices = useMemo(() => {
    return [...agents, ...backendServices];
  }, [agents, backendServices]);

  // Helper to look up the human‐friendly name (or fall back to the id)
  const getServiceNameById = useCallback(
    (serviceId: string) =>
      allServices.find((s) => s.id === serviceId)?.name || serviceId,
    [allServices]
  );

  // Get service status icon
  const getServiceStatusIcon = () => {
    // Mock status - in real implementation, this would come from health checks
    const isHealthy = Math.random() > 0.1; // 90% healthy for demo
    const isChecking = Math.random() > 0.95; // 5% checking

    if (isChecking) {
      return (
        <Clock
          className="w-3 h-3 text-yellow-400 animate-spin"
          aria-label="Checking status"
        />
      );
    }
    if (isHealthy) {
      return (
        <CheckCircle
          className="w-3 h-3 text-emerald-400"
          aria-label="Service healthy"
        />
      );
    }
    return (
      <XCircle
        className="w-3 h-3 text-red-400"
        aria-label="Service unhealthy"
      />
    );
  };

  // Get cost indicator
  const getCostIndicator = (costProfile: string) => {
    const colors = {
      high: "text-red-400",
      medium: "text-yellow-400",
      low: "text-emerald-400",
    };
    const labels = {
      high: "$$$",
      medium: "$$",
      low: "$",
    };
    return (
      <span
        className={`text-xs font-mono ${
          colors[costProfile as keyof typeof colors] || "text-gray-400"
        }`}
        aria-label={`Cost profile: ${costProfile}`}
      >
        {labels[costProfile as keyof typeof labels] || "$"}
      </span>
    );
  };

  const fetchModelStatus = useCallback(async () => {
    try {
      setError(null);
      const status = await cleanProviderService.getActiveModels();
      setModelStatus(status);
    } catch (err) {
      console.error("Failed to fetch model status:", err);
      setError("Failed to fetch model status");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Real-time updates with optimistic updates
  useEffect(() => {
    fetchModelStatus();

    // Auto-refresh every 30 seconds for real-time updates
    const interval = setInterval(fetchModelStatus, 30000);

    // Listen for agent configuration changes to trigger optimistic updates
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleAgentUpdate = () => {
      // Debounce refreshes to prevent excessive API calls
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        setIsRefreshing(true);
        fetchModelStatus();
      }, 300); // Wait 300ms before refreshing
    };

    // Add event listeners for agent updates (can be enhanced with actual event system)
    window.addEventListener("agentConfigUpdated", handleAgentUpdate);

    return () => {
      clearInterval(interval);
      window.removeEventListener("agentConfigUpdated", handleAgentUpdate);
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
    };
  }, [fetchModelStatus]);

  // Enhanced refresh with optimistic feedback
  const handleRefresh = async () => {
    setIsRefreshing(true);

    try {
      await fetchModelStatus();
      // Show success feedback
      const event = new CustomEvent("statusBarRefreshed", {
        detail: { timestamp: new Date().toISOString() },
      });
      window.dispatchEvent(event);
    } catch (error) {
      // Error is already handled in fetchModelStatus
    }
  };

  // Always show a bar, even while loading
  if (loading || servicesLoading) {
    return (
      <div className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-700 px-4 py-1.5 shadow-lg">
        <div className="flex items-center gap-2 text-gray-400">
          <Cpu className="w-3 h-3 animate-pulse" />
          <span className="text-xs">
            Loading {loading ? "model status" : "service registry"}...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border-b border-red-800 px-4 py-1.5">
        <div className="flex items-center gap-2 text-red-400">
          <AlertCircle className="w-3 h-3" />
          <span className="text-xs">{error}</span>
        </div>
      </div>
    );
  }

  if (!modelStatus) {
    return null;
  }

  return (
    <div
      className="bg-gray-900/95 backdrop-blur-sm border-b border-gray-700 shadow-lg"
      id="model-status-bar"
    >
      {/* Mobile-first responsive design */}
      <div className="px-2 py-1.5 sm:px-4">
        <div className="flex items-center justify-between">
          {/* Left Section - Services and Models */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0 flex-1">
            {/* Services Status - Compact on mobile */}
            <div className="flex items-center gap-1 sm:gap-2">
              <Activity className="w-3 h-3 text-blue-400 flex-shrink-0" />
              <span className="text-xs font-medium text-gray-300 hidden sm:inline">
                Services:
              </span>
              <div className="flex items-center gap-1 overflow-hidden">
                {allServices
                  .slice(
                    0,
                    isExpanded
                      ? allServices.length
                      : responsiveValues.maxServices
                  )
                  .map((service) => (
                    <div
                      key={service.id}
                      className="flex items-center gap-1 bg-gray-800/50 rounded px-1 sm:px-1.5 py-0.5 hover:bg-gray-700/50 transition-colors cursor-pointer flex-shrink-0"
                      onClick={() => handleNavigate("/agents")}
                      role="button"
                      tabIndex={0}
                      aria-label={`${service.name} - ${
                        service.defaultModel || "No model configured"
                      }`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleNavigate("/agents");
                        }
                      }}
                    >
                      {getServiceStatusIcon()}
                      <span className="text-[10px] text-gray-300 truncate max-w-12 sm:max-w-16">
                        {responsiveValues.serviceNameLength
                          ? service.name.substring(
                              0,
                              responsiveValues.serviceNameLength
                            )
                          : service.name}
                      </span>
                      {window.innerWidth >= 640 &&
                        getCostIndicator(service.costProfile)}
                    </div>
                  ))}
                {allServices.length > responsiveValues.maxServices &&
                  !isExpanded && (
                    <span className="text-xs text-gray-500 px-1 flex-shrink-0">
                      +{allServices.length - responsiveValues.maxServices}
                    </span>
                  )}
              </div>
            </div>

            {/* Divider - Hidden on mobile */}
            <div className="hidden sm:block w-px h-4 bg-gray-700" />

            {/* Usage Statistics - Hidden on very small screens */}
            {modelStatus.usage && responsiveValues.showUsageStats && (
              <>
                <div className="flex items-center gap-1.5 text-xs">
                  <Hash className="w-3 h-3 text-cyan-400" />
                  <span className="text-gray-400">Tokens:</span>
                  <span className="font-mono text-cyan-300">
                    {formatTokens(modelStatus.usage.total_tokens_today)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <Coins className="w-3 h-3 text-yellow-400" />
                  <span className="text-gray-400">Today:</span>
                  <span className="font-mono text-yellow-300">
                    {formatCurrency(modelStatus.usage.total_cost_today)}
                  </span>
                </div>

                <div className="w-px h-4 bg-gray-700" />
              </>
            )}

            {/* Models - Compact display */}
            <div className="flex items-center gap-1 sm:gap-2">
              <Cpu className="w-3 h-3 text-blue-400 flex-shrink-0" />
              <span className="text-xs font-medium text-gray-300 hidden sm:inline">
                Models:
              </span>
              <div className="flex items-center gap-1 overflow-hidden">
                {modelStatus.active_models &&
                  Object.entries(modelStatus.active_models)
                    .filter(([service]) => {
                      return agentConfigs[service] !== undefined;
                    })
                    .slice(0, responsiveValues.maxModels)
                    .map(([service, model]) => {
                      const serviceName = getServiceNameById(service);
                      return (
                        <div
                          key={service}
                          className="flex items-center gap-1 bg-gray-800/50 rounded px-1 sm:px-1.5 py-0.5 hover:bg-gray-700/50 transition-colors cursor-pointer flex-shrink-0"
                          onClick={() => handleNavigate("/agents")}
                          role="button"
                          tabIndex={0}
                          title={`${serviceName}: ${model.model_string}`}
                          aria-label={`${serviceName} using ${model.model_string}`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleNavigate("/agents");
                            }
                          }}
                        >
                          <span className="text-[10px] text-gray-400 hidden sm:inline">
                            {serviceName}:
                          </span>
                          <div className="flex items-center gap-1">
                            <div
                              className={`w-1.5 h-1.5 rounded-full ${
                                PROVIDER_COLORS[model.provider] ||
                                PROVIDER_COLORS.unknown
                              }`}
                              title={model.provider}
                              aria-label={`Provider: ${model.provider}`}
                            />
                            <span className="text-[10px] font-mono text-gray-300 truncate max-w-12 sm:max-w-20">
                              {model.model.length >
                              responsiveValues.modelNameLength
                                ? `${model.model.substring(
                                    0,
                                    responsiveValues.modelNameLength
                                  )}...`
                                : model.model}
                            </span>
                            {!model.api_key_configured && (
                              <AlertCircle
                                className="w-2.5 h-2.5 text-yellow-500 flex-shrink-0"
                                aria-label="API key not configured"
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                {modelStatus.active_models &&
                  Object.keys(modelStatus.active_models).length >
                    responsiveValues.maxModels && (
                    <span className="text-xs text-gray-500 px-1 flex-shrink-0">
                      +
                      {Object.keys(modelStatus.active_models).length -
                        responsiveValues.maxModels}
                    </span>
                  )}
              </div>
            </div>
          </div>

          {/* Right Section - Controls */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate("/agents")}
              className="p-1 sm:p-1.5 rounded hover:bg-gray-800 transition-colors text-gray-400 hover:text-white"
              aria-label="Configure agents and services"
            >
              <Settings className="w-3 h-3 sm:w-4 sm:h-4" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1 sm:p-1.5 rounded hover:bg-gray-800 transition-colors text-gray-400 hover:text-white"
              aria-label={
                isExpanded ? "Collapse status bar" : "Expand status bar"
              }
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <ChevronUp className="w-3 h-3 sm:w-4 sm:h-4" />
              ) : (
                <ChevronDown className="w-3 h-3 sm:w-4 sm:h-4" />
              )}
            </Button>

            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-1 sm:p-1.5 rounded hover:bg-gray-800 transition-colors disabled:opacity-50"
              title="Refresh model status"
              aria-label={
                isRefreshing
                  ? "Refreshing model status"
                  : "Refresh model status"
              }
            >
              <RefreshCw
                className={`w-3 h-3 sm:w-4 sm:h-4 text-gray-400 ${
                  isRefreshing ? "animate-spin" : ""
                }`}
              />
            </button>
          </div>
        </div>

        {/* Expanded View with Quick Actions */}
        {isExpanded && (
          <div className="border-t border-gray-700/50 mt-2 pt-3">
            {/* Quick Actions Bar */}
            <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleNavigate("/agents")}
                className="bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-gray-700 hover:text-white text-xs sm:text-sm"
              >
                <Settings className="w-3 h-3 sm:w-4 sm:h-4 mr-1 sm:mr-2" />
                Manage Services
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => handleNavigate("/settings")}
                className="bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-gray-700 hover:text-white text-xs sm:text-sm"
              >
                <Activity className="w-3 h-3 sm:w-4 sm:h-4 mr-1 sm:mr-2" />
                System Settings
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="bg-gray-800/50 border-gray-600 text-gray-300 hover:bg-gray-700 hover:text-white text-xs sm:text-sm disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3 h-3 sm:w-4 sm:h-4 mr-1 sm:mr-2 ${
                    isRefreshing ? "animate-spin" : ""
                  }`}
                />
                {isRefreshing ? "Refreshing..." : "Refresh Status"}
              </Button>
            </div>

            {/* Service Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {allServices.map((service) => (
                <div
                  key={service.id}
                  className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50 hover:bg-gray-700/50 transition-colors cursor-pointer"
                  onClick={() => handleNavigate("/agents")}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleNavigate("/agents");
                    }
                  }}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {getServiceStatusIcon()}
                      <h4 className="text-sm font-medium text-white truncate">
                        {service.name}
                      </h4>
                      <Badge
                        variant={
                          service.category === "agent" ? "primary" : "secondary"
                        }
                        className="text-xs flex-shrink-0"
                      >
                        {service.category}
                      </Badge>
                    </div>
                    {getCostIndicator(service.costProfile)}
                  </div>

                  <p className="text-xs text-gray-400 mb-2 line-clamp-2">
                    {service.description}
                  </p>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Zap className="w-3 h-3 text-gray-500 flex-shrink-0" />
                      <span className="text-xs text-gray-300 truncate">
                        {(() => {
                          // Show active model if available, otherwise show default model
                          const activeModel =
                            modelStatus?.active_models?.[service.id];
                          if (activeModel) {
                            return (
                              activeModel.model_string.split(":")[1] ||
                              activeModel.model_string
                            );
                          }
                          return service.defaultModel ? (
                            service.defaultModel.split(":")[1] ||
                              service.defaultModel
                          ) : (
                            <span className="text-yellow-400">
                              Not configured
                            </span>
                          );
                        })()}
                      </span>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-gray-400 hover:text-white p-1 flex-shrink-0"
                      aria-label={`Configure ${service.name}`}
                    >
                      <ExternalLink className="w-3 h-3" />
                    </Button>
                  </div>

                  {/* Capabilities */}
                  <div className="flex items-center gap-2 mt-2">
                    {service.supportsTemperature && (
                      <Badge variant="outline" className="text-xs px-1 py-0">
                        Temp
                      </Badge>
                    )}
                    {service.supportsMaxTokens && (
                      <Badge variant="outline" className="text-xs px-1 py-0">
                        Tokens
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
