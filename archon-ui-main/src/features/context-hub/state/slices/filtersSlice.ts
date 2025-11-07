import type { StateCreator } from "zustand";
import type { StepType } from "../../types";

export interface FiltersSlice {
  // Search and filtering state
  searchQuery: string;
  selectedTags: string[];
  selectedStepType: StepType | null;

  // Actions
  setSearchQuery: (query: string) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  setSelectedStepType: (stepType: StepType | null) => void;
  clearFilters: () => void;
}

/**
 * Filters Slice
 *
 * Manages search and filter state for Context Hub template libraries.
 * Includes search query, tag selection, and step type filtering.
 *
 * Persisted: YES (search query and selected filters persist across sessions)
 *
 * @example
 * ```typescript
 * const searchQuery = useContextHubStore((s) => s.searchQuery);
 * const setSearchQuery = useContextHubStore((s) => s.setSearchQuery);
 * setSearchQuery("authentication");
 * ```
 */
export const createFiltersSlice: StateCreator<FiltersSlice, [], [], FiltersSlice> = (set) => ({
  // Initial state
  searchQuery: "",
  selectedTags: [],
  selectedStepType: null,

  // Actions
  setSearchQuery: (query) => set({ searchQuery: query }),

  toggleTag: (tag) =>
    set((state) => ({
      selectedTags: state.selectedTags.includes(tag)
        ? state.selectedTags.filter((t) => t !== tag)
        : [...state.selectedTags, tag],
    })),

  clearTags: () => set({ selectedTags: [] }),

  setSelectedStepType: (stepType) => set({ selectedStepType: stepType }),

  clearFilters: () =>
    set({
      searchQuery: "",
      selectedTags: [],
      selectedStepType: null,
    }),
});
