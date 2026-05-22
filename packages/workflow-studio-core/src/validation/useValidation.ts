/**
 * useValidation — one ValidationEngine per WorkflowBuilder mount.
 *
 * Bridges the Zustand builder store (BuilderNode[]) and the ValidationEngine
 * (DagNode[]) via useSyncExternalStore. Handles:
 *
 *  - BuilderNode → DagNode conversion via toWorkflowDefinition (drift 6.5.2).
 *  - useWorkflowApi (not useApiClient — drift 6.5.1) used as the optional
 *    server-tier client.
 *  - focusIssue: writes selectedNodeId + focusedIssue to the store so
 *    panel→inspector navigation goes through the store without creating an
 *    import cycle between the ValidationPanel and validation/types.
 *  - null-safe: when workflow === null, engine receives no nodes and no
 *    definition so both debounced and server tiers are skipped (drift 6.5.3).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ValidationEngine, type EngineSnapshot } from './engine';
import { useBuilderStore } from '../store/builder-store';
import { useWorkflowApi } from '../api/ApiClientProvider';
import { toWorkflowDefinition } from '../exporter/toWorkflowDefinition';
import type { DagNode, WorkflowDefinition } from '../schemas';
import type { Issue } from './types';

export interface UseValidationResult extends EngineSnapshot {
  /** True if any issue has severity === 'error'. */
  hasErrors: boolean;
  /**
   * Navigate the inspector to a specific issue.
   * Sets selectedNodeId (so the canvas focuses the node) and focusedIssue
   * (so the inspector tab can scroll to the relevant field).
   */
  focusIssue: (issue: Issue) => void;
  /** Re-run all validation tiers against the current builder store state. */
  revalidate: () => void;
}

export function useValidation(): UseValidationResult {
  // Client from context — used for the optional server validation tier.
  // useWorkflowApi throws when no provider is present (drift 6.5.1/pre-impl note).
  // The hook is always called inside WorkflowBuilder which wraps ApiClientProvider,
  // so this is safe in production. In tests, wrap in <ApiClientProvider>.
  //
  // Called BEFORE engineRef so `client` is available during the lazy-init below.
  // Hooks run synchronously at the top of the render function — `client` is
  // defined before the ValidationEngine constructor runs. See drift 6.5.7:
  // passing `client` at construction avoids a first-render race where the
  // `[nodes, workflow]` effect (which calls engine.update) would fire before
  // any post-mount client-injection effect, silently skipping the server tier.
  const client = useWorkflowApi();

  // One engine per mount; initialised lazily inside the ref so it is created
  // exactly once per component lifetime (StrictMode-safe: dispose fires on
  // unmount, fresh engine is created on remount — drift 6.5.6).
  const engineRef = useRef<ValidationEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new ValidationEngine({
      client,
      // debounceMs left at default (300 ms); the hook doesn't control it.
    });
  }
  const engine = engineRef.current;

  // Subscribe to engine notifications via useSyncExternalStore.
  // snapshot() is referentially stable per drift 6.4.5 — safe to pass directly.
  // subscribe is wrapped in useCallback so its identity is stable across renders;
  // an unstable subscribe causes useSyncExternalStore to re-subscribe on every
  // render, and combined with strict-mode mount/unmount can churn.
  const subscribe = useCallback(
    (onStoreChange: () => void) => engine.subscribe(onStoreChange),
    [engine]
  );
  const getSnapshot = useCallback(() => engine.snapshot(), [engine]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Store selectors — use getState() to avoid creating new refs each render.
  const nodes = useBuilderStore(s => s.nodes);
  const workflow = useBuilderStore(s => s.workflow);

  // Re-run engine.update whenever nodes or workflow changes.
  // BuilderNode[] → DagNode[] via toWorkflowDefinition (drift 6.5.2).
  // Note: if workflow is null, all nodes are skipped — this is intentional for the
  // load-then-clear lifecycle, but means addNode-before-loadWorkflow paths (currently
  // none exist) would silently skip validation. Reconsider if that lifecycle changes.
  useEffect(() => {
    const definition = workflow ? toWorkflowDefinition({ meta: workflow, nodes }) : undefined;
    // definition.nodes is the flat DagNode-shaped array produced by toDag().
    // toWorkflowDefinition returns Record<string, unknown>, not WorkflowDefinition,
    // so we cast through unknown (drift 6.5.3 — the engine forwards it to the
    // client unchanged; type loosening is acceptable here).
    const dagNodes = (definition ? (definition.nodes as unknown[]) : []) as readonly DagNode[];
    engine.update({
      nodes: dagNodes,
      definition: definition as unknown as WorkflowDefinition,
    });
  }, [engine, nodes, workflow]);

  // Dispose the engine when this component unmounts.
  // Deps are `[]` (not `[engine]`) so React StrictMode's mount/cleanup/remount
  // cycle does not churn the engine: if [engine] were the dep and the cleanup
  // nulled engineRef.current, the next render's lazy-init would create engine2,
  // the effect would see a new dep, fire cleanup, null the ref, and so on
  // forever. The empty deps guarantee this effect runs only on real mount/
  // unmount, with the cleanup reading engineRef.current at unmount time.
  useEffect(() => {
    return (): void => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // focusIssue: push selection + focusedIssue into the store.
  // Wrapped in useCallback with stable deps so downstream memoisation works.
  const focusIssue = useCallback(
    (issue: Issue) => {
      const { setSelection, setFocusedIssue } = useBuilderStore.getState();
      if (issue.path.nodeId !== undefined) {
        setSelection([issue.path.nodeId]);
      }
      setFocusedIssue(issue.path);
    },
    [] // no deps — reads from getState() which is always current
  );

  // revalidate: re-run all validation tiers against the engine's last input.
  // Stable identity via useCallback([], []) matches the focusIssue precedent.
  const revalidate = useCallback((): void => {
    engineRef.current?.revalidate();
  }, []);

  // Memoise the returned object so consumers observe referential stability
  // matching the engine's snapshot stability (drift 6.4.5). Without this, every
  // parent re-render would hand consumers a fresh object literal, defeating
  // memoisation downstream (ValidationPanel, Save gate).
  // `snapshot` is stable-by-reference (engine memoizes); `focusIssue` is stable
  // via useCallback([], []). So this object becomes a new reference only when
  // validation state actually changes.
  return useMemo(
    () => ({
      ...snapshot,
      hasErrors: snapshot.issues.some(i => i.severity === 'error'),
      focusIssue,
      revalidate,
    }),
    [snapshot, focusIssue, revalidate]
  );
}
