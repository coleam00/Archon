/**
 * Per-project display-name overrides. Lives in localStorage so the rename is
 * scoped to the spike and survives reloads without backend changes.
 */
import { useEffect, useState } from 'react';

const key = (projectId: string): string => `console:displayName:${projectId}`;

const listeners = new Set<() => void>();

export function getDisplayName(projectId: string, fallback: string): string {
  return localStorage.getItem(key(projectId)) ?? fallback;
}

export function setDisplayName(projectId: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed === '') localStorage.removeItem(key(projectId));
  else localStorage.setItem(key(projectId), trimmed);
  for (const l of listeners) l();
}

export function useDisplayName(projectId: string, fallback: string): string {
  const [value, setValue] = useState(() => getDisplayName(projectId, fallback));
  useEffect(() => {
    const sync = (): void => {
      setValue(getDisplayName(projectId, fallback));
    };
    listeners.add(sync);
    sync();
    return (): void => {
      listeners.delete(sync);
    };
  }, [projectId, fallback]);
  return value;
}
