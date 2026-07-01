/**
 * Selected-project state for the connected builder, backed by localStorage and
 * seeded from the `?project=` search param when present (so a deep-link reload
 * restores the cwd). Every storage access is try/catch-guarded — a
 * disabled/over-quota store falls back to `undefined`, never throws (mirrors
 * `ProjectRail`'s railWidth guard).
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

const STORAGE_KEY = 'archon.console.builderProject';

function readStored(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(id: string | undefined): void {
  try {
    if (id === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export interface BuilderProjectState {
  projectId: string | undefined;
  setProjectId: (id: string | undefined) => void;
}

export function useBuilderProject(): BuilderProjectState {
  const [searchParams] = useSearchParams();
  // Treat an absent OR empty `?project=` as "no selection" so a bare `project=`
  // never shadows the persisted default.
  const paramProject = searchParams.get('project') || undefined;

  // Seed from the deep-link param, else the persisted default.
  const [projectId, setProjectIdState] = useState<string | undefined>(
    () => paramProject ?? readStored()
  );

  // Follow later `?project=` changes while the route stays mounted (browser
  // back/forward, or a link to another builder project). Without this the hook
  // would keep the stale seed and `BuilderConnected`'s sync effect would push it
  // back into the URL, fighting the navigation.
  useEffect((): void => {
    if (paramProject === undefined || paramProject === projectId) return;
    setProjectIdState(paramProject);
    writeStored(paramProject);
  }, [paramProject, projectId]);

  const setProjectId = useCallback((id: string | undefined): void => {
    setProjectIdState(id);
    writeStored(id);
  }, []);

  return { projectId, setProjectId };
}
