/**
 * Service Registry API Service
 *
 * Handles all interactions with the service registry database API
 * for managing services and agents using LLMs.
 */

import { apiRequest } from "./api";

// Types matching the backend ServiceInfo model
export interface ServiceInfo {
  id: string;
  service_name: string;
  display_name: string;
  description?: string;
  icon?: string;
  category: "agent" | "service";
  service_type: "pydantic_ai" | "backend_service" | "embedding_service";
  model_type: "llm" | "embedding";
  location?: string;
  supports_temperature: boolean;
  supports_max_tokens: boolean;
  default_model?: string;
  cost_profile?: "low" | "medium" | "high";
  is_active: boolean;
  is_deprecated: boolean;
  deprecation_reason?: string;
  replacement_service?: string;
  owner_team?: string;
  contact_email?: string;
  documentation_url?: string;
  first_seen?: string;
  last_used?: string;
  created_at: string;
  updated_at: string;
}

export interface ServiceRegistration {
  service_name: string;
  display_name: string;
  description?: string;
  icon?: string;
  category: "agent" | "service";
  service_type: "pydantic_ai" | "backend_service" | "embedding_service";
  model_type: "llm" | "embedding";
  location?: string;
  supports_temperature?: boolean;
  supports_max_tokens?: boolean;
  default_model?: string;
  cost_profile?: "low" | "medium" | "high";
  owner_team?: string;
  contact_email?: string;
  documentation_url?: string;
}

export interface ServiceRegistryStatistics {
  total_services: number;
  active_services: number;
  deprecated_services: number;
  agents: number;
  backend_services: number;
  unregistered_services: number;
  orphaned_registry_entries: number;
  deprecated_needing_cleanup: number;
  services_by_team: Record<string, number>;
  services_by_cost_profile: Record<string, number>;
  validation_issues: {
    unregistered: Array<{
      service_name: string;
      model_string: string;
      issue: string;
    }>;
    orphaned: Array<{
      service_name: string;
      display_name: string;
      issue: string;
    }>;
    deprecated: Array<{
      service_name: string;
      display_name: string;
      deprecation_reason?: string;
    }>;
  };
  last_check: string;
}

// API base path
const API_BASE = "/providers/services";

class ServiceRegistryService {
  // ==================== Registry Management ====================

  /**
   * Get all services from the registry
   */
  async getAllServices(
    activeOnly: boolean = true,
    category?: "agent" | "service"
  ): Promise<ServiceInfo[]> {
    const params = new URLSearchParams();
    if (activeOnly !== undefined)
      params.append("active_only", activeOnly.toString());
    if (category) params.append("category", category);

    const url = params.toString()
      ? `${API_BASE}/registry?${params}`
      : `${API_BASE}/registry`;

    return apiRequest<ServiceInfo[]>(url);
  }

  /**
   * Get all agents from the registry
   */
  async getAgents(activeOnly: boolean = true): Promise<ServiceInfo[]> {
    const params = new URLSearchParams();
    if (activeOnly !== undefined)
      params.append("active_only", activeOnly.toString());

    const url = params.toString()
      ? `${API_BASE}/agents?${params}`
      : `${API_BASE}/agents`;

    return apiRequest<ServiceInfo[]>(url);
  }

  /**
   * Get all backend services from the registry
   */
  async getBackendServices(activeOnly: boolean = true): Promise<ServiceInfo[]> {
    const params = new URLSearchParams();
    if (activeOnly !== undefined)
      params.append("active_only", activeOnly.toString());

    const url = params.toString()
      ? `${API_BASE}/backend?${params}`
      : `${API_BASE}/backend`;

    return apiRequest<ServiceInfo[]>(url);
  }

  /**
   * Get specific service information
   */
  async getService(serviceName: string): Promise<ServiceInfo> {
    if (!serviceName || serviceName.trim() === "") {
      throw new Error("Invalid service name");
    }
    return apiRequest<ServiceInfo>(
      `${API_BASE}/${encodeURIComponent(serviceName)}`
    );
  }

  /**
   * Register a new service
   */
  async registerService(
    registration: ServiceRegistration
  ): Promise<ServiceInfo> {
    return apiRequest<ServiceInfo>(`${API_BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });
  }

  /**
   * Deprecate a service
   */
  async deprecateService(
    serviceName: string,
    reason: string,
    replacementService?: string
  ): Promise<{ status: string; service: string; reason: string }> {
    const params = new URLSearchParams();
    params.append("reason", reason);
    if (replacementService)
      params.append("replacement_service", replacementService);

    return apiRequest(`${API_BASE}/${serviceName}/deprecate?${params}`, {
      method: "POST",
    });
  }

  // ==================== Registry Management ====================

  /**
   * Get comprehensive registry statistics
   */
  async getRegistryStatistics(): Promise<ServiceRegistryStatistics> {
    return apiRequest<ServiceRegistryStatistics>(
      `${API_BASE}/registry/statistics`
    );
  }

  /**
   * Initialize service registry with AGENT_CONFIGS data
   */
  async initializeRegistry(): Promise<{
    status: string;
    frontend_configs_registered: number;
    auto_discovered_registered: number;
    total_services: number;
    message: string;
  }> {
    return apiRequest(`${API_BASE}/registry/initialize`, {
      method: "POST",
    });
  }

  /**
   * Sync registry with current model configurations
   */
  async syncRegistryWithConfigs(): Promise<{
    status: string;
    services_discovered: number;
    services_registered: number;
    sync_time: string;
  }> {
    return apiRequest(`${API_BASE}/registry/sync`, {
      method: "POST",
    });
  }

  /**
   * Validate registry completeness
   */
  async validateRegistry(): Promise<{
    status: string;
    issues: string[];
    warnings: string[];
    unregistered_services: Array<{
      service_name: string;
      model_string: string;
    }>;
    orphaned_entries: Array<{ service_name: string; display_name: string }>;
    deprecated_still_used: Array<{
      service_name: string;
      display_name: string;
      last_used?: string;
    }>;
    validation_time: string;
  }> {
    return apiRequest(`${API_BASE}/registry/validate`);
  }

  // ==================== Helper Methods ====================

  /**
   * Convert ServiceInfo to legacy AgentConfig format for backward compatibility
   */
  serviceInfoToAgentConfig(service: ServiceInfo): any {
    return {
      id: service.service_name,
      name: service.display_name,
      icon: service.icon || "🔧",
      description: service.description || "",
      category: service.category,
      supportsTemperature: service.supports_temperature,
      supportsMaxTokens: service.supports_max_tokens,
      defaultModel: service.default_model || "openai:gpt-4o-mini",
      modelType: service.model_type,
      costProfile: service.cost_profile || "medium",
    };
  }

  /**
   * Get services in legacy AGENT_CONFIGS format for compatibility
   */
  async getServicesAsAgentConfigs(): Promise<Record<string, any>> {
    try {
      const services = await this.getAllServices(true);
      const agentConfigs: Record<string, any> = {};

      for (const service of services) {
        agentConfigs[service.service_name] =
          this.serviceInfoToAgentConfig(service);
      }

      return agentConfigs;
    } catch (error) {
      console.error(
        "[ServiceRegistryService] Failed to get services as agent configs:",
        error
      );
      throw error;
    }
  }

  /**
   * Get only agents in legacy format
   */
  async getAgentsAsConfigs(): Promise<any[]> {
    try {
      const agents = await this.getAgents(true);
      return agents.map((agent) => this.serviceInfoToAgentConfig(agent));
    } catch (error) {
      console.error(
        "[ServiceRegistryService] Failed to get agents as configs:",
        error
      );
      throw error;
    }
  }

  /**
   * Get only services in legacy format
   */
  async getServicesAsConfigs(): Promise<any[]> {
    try {
      const services = await this.getBackendServices(true);
      return services.map((service) => this.serviceInfoToAgentConfig(service));
    } catch (error) {
      console.error(
        "[ServiceRegistryService] Failed to get services as configs:",
        error
      );
      throw error;
    }
  }
}

// Export singleton instance
export const serviceRegistryService = new ServiceRegistryService();

// Export types for convenience
export type { ServiceInfo, ServiceRegistration, ServiceRegistryStatistics };
