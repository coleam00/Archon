/**
 * Knowledge Filter Context
 * Provides shared filter state between KnowledgeView components and hooks
 *
 * This solves the optimistic updates issue where mutations need to know
 * the current filter state to update the correct cached query.
 */

import React, { createContext, useContext, useMemo, useState } from "react";
import type { KnowledgeItemsFilter } from "../types";

interface KnowledgeFilterContextType {
  // Current filter state
  searchQuery: string;
  typeFilter: "all" | "technical" | "business";

  // Filter state setters
  setSearchQuery: (query: string) => void;
  setTypeFilter: (type: "all" | "technical" | "business") => void;

  // Computed filter object for API queries
  currentFilter: KnowledgeItemsFilter;
}

const KnowledgeFilterContext = createContext<KnowledgeFilterContextType | null>(null);

interface KnowledgeFilterProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that manages knowledge filter state
 */
export function KnowledgeFilterProvider({ children }: KnowledgeFilterProviderProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "technical" | "business">("all");

  // Build filter object for API - memoize to prevent recreating on every render
  const currentFilter = useMemo<KnowledgeItemsFilter>(() => {
    const filter: KnowledgeItemsFilter = {
      page: 1,
      per_page: 100,
    };

    if (searchQuery) {
      filter.search = searchQuery;
    }

    if (typeFilter !== "all") {
      filter.knowledge_type = typeFilter;
    }

    return filter;
  }, [searchQuery, typeFilter]);

  const value = useMemo<KnowledgeFilterContextType>(
    () => ({
      searchQuery,
      typeFilter,
      setSearchQuery,
      setTypeFilter,
      currentFilter,
    }),
    [searchQuery, typeFilter, currentFilter]
  );

  return (
    <KnowledgeFilterContext.Provider value={value}>
      {children}
    </KnowledgeFilterContext.Provider>
  );
}

/**
 * Hook to access knowledge filter context
 * @throws Error if used outside of KnowledgeFilterProvider
 */
export function useKnowledgeFilter() {
  const context = useContext(KnowledgeFilterContext);

  if (!context) {
    throw new Error("useKnowledgeFilter must be used within a KnowledgeFilterProvider");
  }

  return context;
}