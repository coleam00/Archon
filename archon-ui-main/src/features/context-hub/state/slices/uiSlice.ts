import type { StateCreator } from "zustand";
import type { ContextHubTab, ViewMode } from "../../types";

export interface UISlice {
  // State
  activeTab: ContextHubTab;
  viewMode: ViewMode;

  // Actions
  setActiveTab: (tab: ContextHubTab) => void;
  setViewMode: (mode: ViewMode) => void;
  resetUIState: () => void;
}

/**
 * UI Slice
 *
 * Manages user interface preferences for Context Hub.
 * Includes active tab and view mode (grid/list).
 *
 * Persisted: YES (via persist middleware in main store)
 *
 * @example
 * ```typescript
 * const activeTab = useContextHubStore((s) => s.activeTab);
 * const setActiveTab = useContextHubStore((s) => s.setActiveTab);
 * setActiveTab("workflows");
 * ```
 */
export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
  // Initial state
  activeTab: "agents",
  viewMode: "grid",

  // Actions
  setActiveTab: (tab) => set({ activeTab: tab }),

  setViewMode: (mode) => set({ viewMode: mode }),

  resetUIState: () =>
    set({
      activeTab: "agents",
      viewMode: "grid",
    }),
});
