/**
 * Owns the `GET workflow → fromWorkflowDefinition → useBuilderStore.loadWorkflow`
 * sequence for the studio-backed builder route. Consumer contract:
 *   - `name === null` → idle, no network.
 *   - `name !== null` → loads via `client.getWorkflow(name, cwd ?? '')`; on 404,
 *     seeds an empty meta with the requested name so the page treats it as
 *     "create new with that name"; on other errors, surfaces `error`.
 *
 * The hook itself is a thin `useEffect` wrapper around `hydrateWorkflowOnce`,
 * which is exported for unit tests so they can exercise the sequence without
 * a DOM (the `src/hooks/` test batch does not preload happy-dom).
 */
import { useEffect, useState } from 'react';
import {
  fromWorkflowDefinition,
  useBuilderStore,
  type LoadWorkflowInput,
  type WorkflowApiClient,
} from '@archon/workflow-studio-core';

export type HydrationStatus = 'idle' | 'loading' | 'loaded' | 'not-found' | 'error';

export interface UseWorkflowHydrationResult {
  status: HydrationStatus;
  error: Error | null;
}

export interface HydrationOutcome {
  status: Exclude<HydrationStatus, 'idle' | 'loading'>;
  error: Error | null;
}

/**
 * Pure async helper — performs the GET, classifies the result, and applies the
 * result to the supplied `loadWorkflow` function. Returns the terminal status
 * so the caller can drive UI state, or `null` if cancellation fires before any
 * store mutation happens.
 *
 * `isCancelled` is consulted at every async boundary; when true, the function
 * returns early WITHOUT invoking `loadWorkflow`. This lets the React effect
 * cancel in-flight hydrations across name changes / unmounts without leaking
 * stale store writes.
 */
export async function hydrateWorkflowOnce(
  client: WorkflowApiClient,
  name: string,
  cwd: string,
  loadWorkflow: (input: LoadWorkflowInput) => void,
  isCancelled: () => boolean = () => false
): Promise<HydrationOutcome | null> {
  try {
    const definition = await client.getWorkflow(name, cwd);
    if (isCancelled()) return null;
    const input = fromWorkflowDefinition(definition as Record<string, unknown>);
    loadWorkflow(input);
    return { status: 'loaded', error: null };
  } catch (error) {
    if (isCancelled()) return null;
    const status = (error as { status?: number }).status;
    if (status === 404) {
      // Seed an empty meta with the requested name so the builder treats this
      // as "create new with that name". `setWorkflowName` only mutates an
      // existing meta — for the not-found path the meta is null until we
      // seed it here.
      loadWorkflow({
        meta: { name, description: '', base: {}, unknown: {} },
        nodes: [],
      });
      return { status: 'not-found', error: null };
    }
    return {
      status: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function useWorkflowHydration(
  name: string | null,
  cwd: string | undefined,
  client: WorkflowApiClient
): UseWorkflowHydrationResult {
  const [status, setStatus] = useState<HydrationStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (name === null) {
      setStatus('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setError(null);

    const loadWorkflow = (input: LoadWorkflowInput): void => {
      useBuilderStore.getState().loadWorkflow(input);
    };

    void hydrateWorkflowOnce(client, name, cwd ?? '', loadWorkflow, () => cancelled).then(
      outcome => {
        if (cancelled || outcome === null) return;
        setStatus(outcome.status);
        setError(outcome.error);
      }
    );

    return (): void => {
      cancelled = true;
    };
  }, [name, cwd, client]);

  return { status, error };
}
