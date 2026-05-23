/**
 * Host-layer draft autosave for the workflow builder.
 *
 * Persists the in-flight workflow definition (meta + nodes) to localStorage
 * so that an unsaved new workflow survives a browser refresh. Scoped narrowly:
 *
 *   - Only restores a draft when hydration status is `not-found` (i.e. the
 *     user is creating a new workflow that does not yet exist on disk).
 *     This avoids silently overwriting a saved workflow with a stale draft.
 *   - Subscribes to `useBuilderStore` and writes the current draft to
 *     localStorage on every change, debounced.
 *   - Caller must invoke `clearDraft()` from the save success branch so the
 *     next page load does not restore a pre-save snapshot.
 *
 * Storage layout: one key per (cwd, workflowName). Cwd is included because
 * the same workflow name can exist in different projects.
 *
 * Lives in the host package (not workflow-studio-core) because draft autosave
 * is a host product decision — CLI / headless embedders of the studio core
 * would not want localStorage coupling.
 */
import { useEffect } from 'react';
import { useBuilderStore, type LoadWorkflowInput } from '@archon/workflow-studio-core';

const DRAFT_KEY_PREFIX = 'archon:workflow-draft:';
const DRAFT_DEBOUNCE_MS = 400;

function draftKey(cwd: string, name: string): string {
  return `${DRAFT_KEY_PREFIX}${cwd}::${name}`;
}

function readDraft(cwd: string, name: string): LoadWorkflowInput | null {
  try {
    const raw = window.localStorage.getItem(draftKey(cwd, name));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Structural sanity check — guard against corrupted entries from prior
    // schema versions. Reject anything that doesn't look like LoadWorkflowInput.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('meta' in parsed) ||
      !('nodes' in parsed) ||
      !Array.isArray((parsed as { nodes: unknown }).nodes)
    ) {
      return null;
    }
    return parsed as LoadWorkflowInput;
  } catch {
    return null;
  }
}

function writeDraft(cwd: string, name: string, input: LoadWorkflowInput): void {
  try {
    window.localStorage.setItem(draftKey(cwd, name), JSON.stringify(input));
  } catch {
    // QuotaExceededError or serialization failure — drafts are best-effort.
    // Failing silently here preserves the page; the in-memory store is the
    // authoritative source until the user saves.
  }
}

export function clearWorkflowDraft(cwd: string, name: string): void {
  try {
    window.localStorage.removeItem(draftKey(cwd, name));
  } catch {
    // ignore
  }
}

/**
 * Subscribes to builder-store changes and persists the workflow draft to
 * localStorage, debounced. Only active when `enabled` is true — callers
 * gate this on `hydrationStatus === 'not-found'`.
 *
 * Also performs a one-shot restore on mount: if `enabled` flips true and a
 * draft exists for (cwd, name), the draft replaces the empty seed in the
 * store.
 */
export function useWorkflowDraft(
  cwd: string | undefined,
  name: string | null,
  enabled: boolean
): void {
  // Restore on enable. Runs once per (cwd, name, enabled) transition.
  useEffect(() => {
    if (!enabled || !cwd || !name) return;
    const draft = readDraft(cwd, name);
    if (!draft) return;
    useBuilderStore.getState().loadWorkflow(draft);
    // No cleanup — restore is idempotent within an effect run, and the
    // subscribe-effect below handles ongoing writes.
  }, [cwd, name, enabled]);

  // Autosave on store change.
  useEffect(() => {
    if (!enabled || !cwd || !name) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useBuilderStore.subscribe(state => {
      if (!state.workflow) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Re-read state at flush time so we always persist the latest
        // snapshot, not the one captured when the change fired.
        const s = useBuilderStore.getState();
        if (!s.workflow) return;
        writeDraft(cwd, name, { meta: s.workflow, nodes: s.nodes });
      }, DRAFT_DEBOUNCE_MS);
    });

    return (): void => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [cwd, name, enabled]);
}
