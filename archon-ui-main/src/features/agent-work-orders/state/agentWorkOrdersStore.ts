import { create } from "zustand";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";
import { createFiltersSlice, type FiltersSlice } from "./slices/filtersSlice";
import { createModalsSlice, type ModalsSlice } from "./slices/modalsSlice";
import { createSSESlice, type SSESlice } from "./slices/sseSlice";
import { createUIPreferencesSlice, type UIPreferencesSlice } from "./slices/uiPreferencesSlice";

/**
 * Combined Agent Work Orders store type
 * Combines all slices into a single store interface
 */
export type AgentWorkOrdersStore = UIPreferencesSlice & ModalsSlice & FiltersSlice & SSESlice;

/**
 * Agent Work Orders global state store
 *
 * Manages:
 * - UI preferences (layout mode, sidebar state) - PERSISTED
 * - Modal state (which modal is open, editing context) - NOT persisted
 * - Filter state (search query, selected repository) - PERSISTED
 * - SSE connections (live updates, connection management) - NOT persisted
 *
 * Does NOT manage:
 * - Server data (TanStack Query handles this)
 * - Ephemeral UI state (local useState for row expansion, etc.)
 *
 * Zustand v5 Selector Patterns:
 * ```typescript
 * import { useShallow } from 'zustand/shallow';
 *
 * // ✅ Single primitive - stable reference
 * const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
 *
 * // ✅ Single action - functions are stable
 * const setLayoutMode = useAgentWorkOrdersStore((s) => s.setLayoutMode);
 *
 * // ✅ Multiple values - use useShallow to prevent infinite loops
 * const { layoutMode, sidebarExpanded } = useAgentWorkOrdersStore(
 *   useShallow((s) => ({
 *     layoutMode: s.layoutMode,
 *     sidebarExpanded: s.sidebarExpanded
 *   }))
 * );
 * ```
 */
export const useAgentWorkOrdersStore = create<AgentWorkOrdersStore>()(
  devtools(
    subscribeWithSelector(
      persist(
        (...a) => ({
          ...createUIPreferencesSlice(...a),
          ...createModalsSlice(...a),
          ...createFiltersSlice(...a),
          ...createSSESlice(...a),
        }),
        {
          name: "agent-work-orders-ui",
          version: 2,
          partialize: (state) => ({
            // Persist UI preferences and search query
            layoutMode: state.layoutMode,
            sidebarExpanded: state.sidebarExpanded,
            searchQuery: state.searchQuery,
            // Persist SSE data to survive HMR
            liveLogs: state.liveLogs,
            liveProgress: state.liveProgress,
            // Do NOT persist:
            // - selectedRepositoryId (URL params are source of truth)
            // - Modal state (ephemeral)
            // - SSE connections (must be re-established, but data is preserved)
            // - connectionStates (transient)
          }),
        },
      ),
    ),
    { name: "AgentWorkOrders" },
  ),
);
