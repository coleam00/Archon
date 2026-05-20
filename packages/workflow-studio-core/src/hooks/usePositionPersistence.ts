import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_PREFIX = 'studio:positions:';
const DEBOUNCE_MS = 200;

export function positionStorageKey(archonUrl: string, cwd: string, workflowName: string): string {
  return `${STORAGE_PREFIX}${archonUrl}::${cwd}::${workflowName}`;
}

export function loadPersistedPositions(
  archonUrl: string,
  cwd: string,
  workflowName: string
): Map<string, { x: number; y: number }> {
  const map = new Map<string, { x: number; y: number }>();
  try {
    const raw = globalThis.localStorage?.getItem(positionStorageKey(archonUrl, cwd, workflowName));
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    for (const [id, pos] of Object.entries(parsed)) {
      if (typeof pos?.x === 'number' && typeof pos?.y === 'number') map.set(id, pos);
    }
  } catch {
    // corrupt payload — ignore, treat as empty
  }
  return map;
}

export function persistPositions(
  archonUrl: string,
  cwd: string,
  workflowName: string,
  positions: ReadonlyMap<string, { x: number; y: number }>
): void {
  const obj: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of positions) obj[id] = pos;
  try {
    globalThis.localStorage?.setItem(
      positionStorageKey(archonUrl, cwd, workflowName),
      JSON.stringify(obj)
    );
  } catch {
    // quota / privacy mode — fail silently; positions are non-critical
  }
}

export interface UsePositionPersistence {
  positions: Map<string, { x: number; y: number }>;
  setPosition: (id: string, pos: { x: number; y: number }) => void;
  setMany: (entries: Iterable<[string, { x: number; y: number }]>) => void;
  reset: () => void;
}

export function usePositionPersistence(
  archonUrl: string,
  cwd: string,
  workflowName: string
): UsePositionPersistence {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(() =>
    loadPersistedPositions(archonUrl, cwd, workflowName)
  );

  // Re-hydrate when the key changes (workflow switch).
  useEffect(() => {
    setPositions(loadPersistedPositions(archonUrl, cwd, workflowName));
  }, [archonUrl, cwd, workflowName]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Map<string, { x: number; y: number }> | null>(null);

  const flush = useCallback(() => {
    if (pendingRef.current) {
      persistPositions(archonUrl, cwd, workflowName, pendingRef.current);
      pendingRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, [archonUrl, cwd, workflowName]);

  // Flush on unmount and on tab hide so a fast drag→close doesn't lose the move.
  useEffect(() => {
    const onHide = (): void => {
      flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return (): void => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flush();
    };
  }, [flush]);

  const schedule = useCallback(
    (next: Map<string, { x: number; y: number }>) => {
      pendingRef.current = next;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        if (pendingRef.current) persistPositions(archonUrl, cwd, workflowName, pendingRef.current);
        pendingRef.current = null;
        debounceRef.current = null;
      }, DEBOUNCE_MS);
    },
    [archonUrl, cwd, workflowName]
  );

  const setPosition = useCallback(
    (id: string, pos: { x: number; y: number }) => {
      setPositions(prev => {
        const next = new Map(prev);
        next.set(id, pos);
        schedule(next);
        return next;
      });
    },
    [schedule]
  );

  const setMany = useCallback(
    (entries: Iterable<[string, { x: number; y: number }]>) => {
      setPositions(prev => {
        const next = new Map(prev);
        for (const [id, pos] of entries) next.set(id, pos);
        schedule(next);
        return next;
      });
    },
    [schedule]
  );

  const reset = useCallback(() => {
    pendingRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    try {
      globalThis.localStorage?.removeItem(positionStorageKey(archonUrl, cwd, workflowName));
    } catch {
      // ignore
    }
    setPositions(new Map());
  }, [archonUrl, cwd, workflowName]);

  return useMemo(
    () => ({ positions, setPosition, setMany, reset }),
    [positions, setPosition, setMany, reset]
  );
}
