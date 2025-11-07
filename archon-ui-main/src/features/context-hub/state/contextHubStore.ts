import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { createFiltersSlice, type FiltersSlice } from "./slices/filtersSlice";
import { createModalsSlice, type ModalsSlice } from "./slices/modalsSlice";
import { createUISlice, type UISlice } from "./slices/uiSlice";

/**
 * Combined Context Hub store type
 * Combines all slices into a single store interface
 */
export type ContextHubStore = UISlice & ModalsSlice & FiltersSlice;

/**
 * Context Hub global state store
 *
 * Manages:
 * - UI preferences (active tab, view mode) - PERSISTED
 * - Modal state (which modal is open, editing context) - NOT persisted
 * - Filter state (search query, selected tags, step type) - PERSISTED
 *
 * Does NOT manage:
 * - Server data (TanStack Query handles this)
 * - Ephemeral UI state (local useState for hover states, etc.)
 *
 * Zustand v4 Selector Patterns:
 * ```typescript
 * import { useShallow } from 'zustand/react/shallow';
 *
 * // ✅ Single primitive - stable reference
 * const activeTab = useContextHubStore((s) => s.activeTab);
 *
 * // ✅ Single action - functions are stable
 * const setActiveTab = useContextHubStore((s) => s.setActiveTab);
 *
 * // ✅ Multiple values - use useShallow to prevent unnecessary re-renders
 * const { searchQuery, selectedTags } = useContextHubStore(
 *   useShallow((s) => ({
 *     searchQuery: s.searchQuery,
 *     selectedTags: s.selectedTags
 *   }))
 * );
 * ```
 */
export const useContextHubStore = create<ContextHubStore>()(
  devtools(
    subscribeWithSelector(
      persist(
        (...a) => ({
          ...createUISlice(...a),
          ...createModalsSlice(...a),
          ...createFiltersSlice(...a),
        }),
        {
          name: "context-hub-ui",
          version: 1,
          partialize: (state) => ({
            // Persist UI preferences
            activeTab: state.activeTab,
            viewMode: state.viewMode,
            // Persist filter state
            searchQuery: state.searchQuery,
            selectedTags: state.selectedTags,
            selectedStepType: state.selectedStepType,
            // Do NOT persist:
            // - Modal state (ephemeral)
            // - Editing context (transient)
          }),
        },
      ),
    ),
    { name: "ContextHub" },
  ),
);
