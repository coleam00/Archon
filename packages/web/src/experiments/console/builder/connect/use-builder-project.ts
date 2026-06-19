/**
 * Selected-project state for the connected builder, backed by localStorage and
 * seeded from the `?project=` search param when present (so a deep-link reload
 * restores the cwd). Every storage access is try/catch-guarded — a
 * disabled/over-quota store falls back to `undefined`, never throws (mirrors
 * `ProjectRail`'s railWidth guard).
 */
import { useCallback, useState } from 'react';
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
  const paramProject = searchParams.get('project') ?? undefined;

  // Seed once: the deep-link param wins over the persisted default. Later URL
  // changes are driven by `setProjectId` callers, not re-read here.
  const [projectId, setProjectIdState] = useState<string | undefined>(
    () => paramProject ?? readStored()
  );

  const setProjectId = useCallback((id: string | undefined): void => {
    setProjectIdState(id);
    writeStored(id);
  }, []);

  return { projectId, setProjectId };
}
