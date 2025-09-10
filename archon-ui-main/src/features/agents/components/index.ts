/**
 * Agents Components Exports - Organized by Business Domain
 */

// ===== AGENT MANAGEMENT =====
// Core agent configuration and display components
export { AgentsPage } from "./agent-management/AgentsPage";
export { AgentCard } from "./agent-management/AgentCard";
export { AgentModelPanel } from "./agent-management/AgentModelPanel";
export { AgentSettingsDropdown } from "./agent-management/AgentSettingsDropdown";
export { ApiKeysSection } from "./agent-management/ApiKeysSection";
export { NoModelsWarning } from "./agent-management/NoModelsWarning";
export { AgentTabNavigation } from "./agent-management/AgentTabNavigation";

// ===== PROVIDER MANAGEMENT =====
// AI provider setup and configuration components
export { AddProviderModal } from "./provider-management/AddProviderModal";
export { ProviderCard } from "./provider-management/ProviderCard";
export { ProviderSettings } from "./provider-management/ProviderSettings";
export { ProviderForm } from "./provider-management/ProviderForm";
export { ProviderList } from "./provider-management/ProviderList";

// ===== MODEL SELECTION =====
// Model choosing and configuration components
export { ModelSelectionModal } from "./model-selection/ModelSelectionModal";
export { ModelCard } from "./model-selection/ModelCard";
export { AdvancedSettings } from "./model-selection/AdvancedSettings";

// ===== UI FEEDBACK =====
// User interaction feedback and status components
export {
  OptimisticStatus,
  OptimisticWrapper,
  OptimisticButton,
  OptimisticListItem,
  OptimisticToast,
} from "./ui-feedback/OptimisticUpdateComponents";
export { StatusIndicator } from "./ui-feedback/StatusIndicator";
export { AgentsPageError } from "./ui-feedback/AgentsPageError";

// ===== COMMON COMPONENTS =====
// Reusable UI components used across agent features

// ===== COMMON COMPONENTS & UTILITIES =====
// Shared components, utilities, hooks, and styles
export * from "./common";

// ===== UTILITIES =====
// Helper functions and utilities
export * from "./model-selection/modelSelectionUtils";
