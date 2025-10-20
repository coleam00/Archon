/**
 * Knowledge Filter Context
 * Provides current filter state to mutation hooks for optimistic updates
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import type { KnowledgeItemsFilter } from "../types";

interface KnowledgeFilterContextValue {
  currentFilter: KnowledgeItemsFilter;
  setFilter: (filter: KnowledgeItemsFilter) => void;
}

const KnowledgeFilterContext = createContext<KnowledgeFilterContextValue | undefined>(undefined);

export function KnowledgeFilterProvider({ children }: { children: ReactNode }) {
  const [currentFilter, setFilter] = useState<KnowledgeItemsFilter>({});

  return (
    <KnowledgeFilterContext.Provider value={{ currentFilter, setFilter }}>
      {children}
    </KnowledgeFilterContext.Provider>
  );
}

export function useKnowledgeFilterContext() {
  const context = useContext(KnowledgeFilterContext);
  if (!context) {
    throw new Error("useKnowledgeFilterContext must be used within KnowledgeFilterProvider");
  }
  return context;
}
