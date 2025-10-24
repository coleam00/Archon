import { useCallback, useState } from "react";

const STORAGE_KEY = "archon:selectedProjectId";

// Load initial value synchronously to avoid race conditions
const getInitialValue = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const useSelectedProjectId = () => {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(getInitialValue);

  const updateSelectedProjectId = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    try {
      if (projectId) {
        window.localStorage.setItem(STORAGE_KEY, projectId);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  return { selectedProjectId, setSelectedProjectId: updateSelectedProjectId };
};


