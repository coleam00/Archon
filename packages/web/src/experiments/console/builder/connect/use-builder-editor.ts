/**
 * Editing session for the connected builder: the live workflow, the dirty flag
 * and its unsaved-changes guards, panel issues, the busy flag, and the source a
 * bundled Save-as can flip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BuilderWorkflow, Issue } from '../types';
import type { Workflow } from '../../primitives/workflow';
import { isReadOnlySource } from './save-logic';
import type { ImportResult } from '../model';

export interface BuilderEditorInput {
  imported: ImportResult | null;
  /** Editor identity (cwd + name + mode); BuilderPage is keyed by it too. */
  editorKey: string;
  isCreateMode: boolean;
  loadedSource: Workflow['source'];
  notices: Issue[] | undefined;
}

export interface BuilderEditor {
  currentWorkflow: BuilderWorkflow | null;
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  setServerIssues: (issues: Issue[]) => void;
  setSourceOverride: (source: Workflow['source'] | null) => void;
  effectiveSource: Workflow['source'];
  readOnly: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Runs `action` unless there are unsaved changes the operator won't discard. */
  confirmIfDirty: (action: () => void) => void;
  handleChange: (bw: BuilderWorkflow) => void;
  extraIssues: Issue[];
}

/** beforeunload guard (reload/tab-close) — armed only while dirty. */
function useBeforeUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return (): void => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty]);
}

export function useBuilderEditor({
  imported,
  editorKey,
  isCreateMode,
  loadedSource,
  notices,
}: BuilderEditorInput): BuilderEditor {
  // Editing state — reset whenever the imported workflow changes (workflow switch).
  const [currentWorkflow, setCurrentWorkflow] = useState<BuilderWorkflow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  // Source can flip after a bundled Save-as (bundled → project override).
  // Widened to `Workflow['source']` (#2578) to match `loadedSource` /
  // `LoadedWorkflow.source` — `saveWorkflow` returns whatever the server put on
  // the response, which is `Workflow['source']`-typed.
  const [sourceOverride, setSourceOverride] = useState<Workflow['source'] | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveSource = sourceOverride ?? loadedSource;

  // Initialize editing state ONCE per editor identity (cwd + name + mode), not on
  // every `imported` identity change. A successful Save invalidates the workflow
  // cache, which re-runs the loader and yields a fresh `imported` for the SAME
  // workflow; resetting on that refetch would clobber live edits and silently
  // clear `dirty` in the window between Save resolving and the refetch landing.
  // BuilderPage is keyed by the same identity, so it remounts in lockstep. When
  // `imported` becomes null (picker view / still loading) the ref is cleared so
  // the next load re-initializes cleanly.
  const initedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (imported === null) {
      // No workflow open (picker view, or still loading) — return to a clean
      // closed state so the dirty flag / beforeunload guard don't linger.
      initedKeyRef.current = null;
      setCurrentWorkflow(null);
      setDirty(false);
      setSourceOverride(null);
      return;
    }
    if (initedKeyRef.current === editorKey) return; // same workflow refetched — keep edits
    initedKeyRef.current = editorKey;
    setCurrentWorkflow(imported.workflow);
    setDirty(isCreateMode);
    setSourceOverride(null);
    setServerIssues(notices ?? []);
  }, [imported, editorKey, isCreateMode, notices]);

  useBeforeUnloadGuard(dirty);

  const confirmIfDirty = useCallback(
    (action: () => void): void => {
      if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
      action();
    },
    [dirty]
  );

  const handleChange = useCallback((bw: BuilderWorkflow): void => {
    setCurrentWorkflow(bw);
    setDirty(true);
  }, []);

  const extraIssues = useMemo(
    () => [...(imported?.issues ?? []), ...serverIssues],
    [imported, serverIssues]
  );

  return {
    currentWorkflow,
    dirty,
    setDirty,
    setServerIssues,
    setSourceOverride,
    effectiveSource,
    readOnly: isReadOnlySource(effectiveSource),
    busy,
    setBusy,
    confirmIfDirty,
    handleChange,
    extraIssues,
  };
}
