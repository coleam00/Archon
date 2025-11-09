import type { StateCreator } from "zustand";

export type LayoutMode = "horizontal" | "sidebar";

export type UIPreferencesSlice = {
  // State
  layoutMode: LayoutMode;
  sidebarExpanded: boolean;

  // Actions
  setLayoutMode: (mode: LayoutMode) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  toggleSidebar: () => void;
  resetUIPreferences: () => void;
};

/**
 * UI Preferences Slice
 *
 * Manages user interface preferences that should persist across sessions.
 * Includes layout mode (horizontal/sidebar) and sidebar expansion state.
 *
 * Persisted: YES (via persist middleware in main store)
 *
 * @example
 * ```typescript
 * const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
 * const setLayoutMode = useAgentWorkOrdersStore((s) => s.setLayoutMode);
 * setLayoutMode("horizontal");
 * ```
 */
export const createUIPreferencesSlice: StateCreator<UIPreferencesSlice, [], [], UIPreferencesSlice> = (set) => ({
  // Initial state
  layoutMode: "sidebar",
  sidebarExpanded: true,

  // Actions
  setLayoutMode: (mode) => set({ layoutMode: mode }),

  setSidebarExpanded: (expanded) => set({ sidebarExpanded: expanded }),

  toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),

  resetUIPreferences: () =>
    set({
      layoutMode: "sidebar",
      sidebarExpanded: true,
    }),
});
