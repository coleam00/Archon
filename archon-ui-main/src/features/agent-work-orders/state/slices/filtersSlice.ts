import type { StateCreator } from "zustand";

export type FiltersSlice = {
  // State
  searchQuery: string;
  selectedRepositoryId: string | undefined;

  // Actions
  setSearchQuery: (query: string) => void;
  selectRepository: (id: string | undefined, syncUrl?: (id: string | undefined) => void) => void;
  clearFilters: () => void;
};

/**
 * Filters Slice
 *
 * Manages filter and selection state for repositories and work orders.
 * Includes search query and selected repository ID.
 *
 * Persisted: YES (search/selection survives reload)
 *
 * URL Sync: selectedRepositoryId should also update URL query params.
 * Use the syncUrl callback to keep URL in sync.
 *
 * @example
 * ```typescript
 * // Set search query
 * const setSearchQuery = useAgentWorkOrdersStore((s) => s.setSearchQuery);
 * setSearchQuery("my-repo");
 *
 * // Select repository with URL sync
 * const selectRepository = useAgentWorkOrdersStore((s) => s.selectRepository);
 * selectRepository("repo-id-123", (id) => {
 *   setSearchParams(id ? { repo: id } : {});
 * });
 * ```
 */
export const createFiltersSlice: StateCreator<FiltersSlice, [], [], FiltersSlice> = (set) => ({
  // Initial state
  searchQuery: "",
  selectedRepositoryId: undefined,

  // Actions
  setSearchQuery: (query) => set({ searchQuery: query }),

  selectRepository: (id, syncUrl) => {
    set({ selectedRepositoryId: id });
    // Callback to sync with URL search params
    syncUrl?.(id);
  },

  clearFilters: () =>
    set({
      searchQuery: "",
      selectedRepositoryId: undefined,
    }),
});
