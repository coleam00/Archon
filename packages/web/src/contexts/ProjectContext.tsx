import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCodebases } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';

const PROJECT_STORAGE_KEY = 'archon-selected-project';

interface ProjectContextValue {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  codebases: CodebaseResponse[] | undefined;
  isLoadingCodebases: boolean;
  isErrorCodebases: boolean;
}

const projectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PROJECT_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const {
    data: codebases,
    isLoading: isLoadingCodebases,
    isError: isErrorCodebases,
  } = useQuery({
    queryKey: ['codebases'],
    queryFn: listCodebases,
    refetchInterval: 30_000,
  });

  const setSelectedProjectId = useCallback((id: string | null): void => {
    setSelectedProjectIdRaw(id);
    try {
      if (id) {
        localStorage.setItem(PROJECT_STORAGE_KEY, id);
      } else {
        localStorage.removeItem(PROJECT_STORAGE_KEY);
      }
    } catch {
      // localStorage unavailable (e.g. Safari private browsing, quota exceeded)
      // in-memory state already updated above; persistence is best-effort
    }
  }, []); // setSelectedProjectIdRaw is stable (useState setter)

  // Clear stale selection if the project no longer exists
  useEffect(() => {
    if (!codebases) return;
    if (selectedProjectId && !codebases.some(cb => cb.id === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [codebases, selectedProjectId, setSelectedProjectId]);

  return (
    <projectContext.Provider
      value={{
        selectedProjectId,
        setSelectedProjectId,
        codebases,
        isLoadingCodebases,
        isErrorCodebases,
      }}
    >
      {children}
    </projectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(projectContext);
  if (!ctx) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return ctx;
}
