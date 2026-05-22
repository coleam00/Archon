/**
 * Per-project display-name overrides. Lives in localStorage so the rename is
 * scoped to the spike and survives reloads without backend changes.
 */
import { useEffect, useState } from 'react';

const key = (projectId: string): string => `console:displayName:${projectId}`;

const listeners = new Set<() => void>();

// localStorage can throw SecurityError in private-browsing modes or
// when storage is disabled by policy. Treat any failure as "no override
// stored" rather than crashing the rail row on mount.
export function getDisplayName(projectId: string, fallback: string): string {
  try {
    return localStorage.getItem(key(projectId)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setDisplayName(projectId: string, value: string): void {
  const trimmed = value.trim();
  try {
    if (trimmed === '') localStorage.removeItem(key(projectId));
    else localStorage.setItem(key(projectId), trimmed);
  } catch {
    // Override won't persist; UI still updates for the current session
    // because the listeners below still fire.
  }
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
