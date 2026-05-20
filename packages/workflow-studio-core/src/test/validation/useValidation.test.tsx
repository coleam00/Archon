/**
 * Tests for useValidation hook.
 *
 * Drift 6.5.1: Hook is named useWorkflowApi (not useApiClient).
 * Drift 6.5.2: BuilderNode[] must be used with loadWorkflow(), not raw DagNode shape.
 *   The plan's test fixture used { id: '', type: 'prompt', base: { prompt: 'x' } }
 *   which is the DagNode/wrong shape. Correct BuilderNode shape is
 *   { id, variant, data, base, unknown }.
 * Drift 6.5.4: Wrapped renders in <ApiClientProvider> since useWorkflowApi throws
 *   without a provider (non-negotiable — see ApiClientProvider.tsx line 18).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { render, act, cleanup } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { useValidation } from '../../validation/useValidation';
import { useBuilderStore } from '../../store/builder-store';
import { ApiClientProvider } from '../../api/ApiClientProvider';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

beforeEach(() => useBuilderStore.getState().clearWorkflow());
afterEach(() => cleanup());

// Minimal stub client — the hook requires a provider but tests don't exercise
// server validation, so validateWorkflow never resolves with errors.
const stubClient: WorkflowApiClient = {
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async () => [],
  listProviders: async () => [],
  getWorkflow: async () => ({ name: '', description: '', nodes: [] }) as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
};

function Probe({ onState }: { onState: (s: ReturnType<typeof useValidation>) => void }) {
  const state = useValidation();
  onState(state);
  return null;
}

/** Render a Probe component wrapped in the required ApiClientProvider. */
function renderProbe(onState: (s: ReturnType<typeof useValidation>) => void) {
  return render(
    <ApiClientProvider client={stubClient}>
      <Probe onState={onState} />
    </ApiClientProvider>
  );
}

describe('useValidation', () => {
  it('returns no issues on a clean store', () => {
    let last: ReturnType<typeof useValidation> | null = null;
    renderProbe(s => (last = s));
    expect(last!.issues).toEqual([]);
    expect(last!.hasErrors).toBe(false);
  });

  it('reports an instant issue when a node has an empty id', () => {
    // Drift 6.5.2: Use BuilderNode shape, not DagNode raw shape.
    // variant: 'prompt', data: { prompt: 'x' } flows through toWorkflowDefinition →
    // getVariant('prompt').toDag({ prompt: 'x' }) → { prompt: 'x' } and the id ''
    // is preserved, triggering structural.id.empty.
    act(() => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [{ id: '', variant: 'prompt', data: { prompt: 'x' }, base: {}, unknown: {} }],
      });
    });
    let last: ReturnType<typeof useValidation> | null = null;
    renderProbe(s => (last = s));
    expect(last!.hasErrors).toBe(true);
    expect(last!.issues.some(i => i.rule === 'structural.id.empty')).toBe(true);
  });

  it('invokes the server tier on first render when client + definition are present', async () => {
    // Regression guard for drift 6.5.7: the engine must have a client at
    // construction time so the very first engine.update() (triggered by the
    // `[nodes, workflow]` effect on first render) can dispatch to the server
    // tier. If the client were injected via a post-mount useEffect declared
    // AFTER the [nodes, workflow] effect, the first update would run with
    // this.client === undefined and silently skip the server tier.
    let called = false;
    const trackingClient = {
      validateWorkflow: async () => {
        called = true;
        return { valid: true };
      },
    } as unknown as WorkflowApiClient;

    act(() => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [{ id: 'a', variant: 'prompt', data: { prompt: 'hi' }, base: {}, unknown: {} }],
      });
    });
    render(
      <ApiClientProvider client={trackingClient}>
        <Probe onState={() => {}} />
      </ApiClientProvider>
    );
    // Default engine debounceMs is 300; give it 400ms to fire the debounced tier
    // followed by the server tier.
    await act(async () => {
      await new Promise(r => setTimeout(r, 400));
    });
    expect(called).toBe(true);
  });

  it('focusIssue sets selectedNodeId and focusedIssue in the store', () => {
    let last: ReturnType<typeof useValidation> | null = null;
    act(() => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [{ id: 'step1', variant: 'prompt', data: { prompt: 'hi' }, base: {}, unknown: {} }],
      });
    });
    renderProbe(s => (last = s));
    act(() => {
      last!.focusIssue({
        id: 'i',
        rule: 'structural.required.prompt',
        severity: 'error',
        source: 'client-instant',
        message: '',
        path: { nodeId: 'step1', field: 'prompt' },
      });
    });
    const storeState = useBuilderStore.getState();
    expect(storeState.primarySelectionId).toBe('step1');
    expect(storeState.focusedIssue).toEqual({ nodeId: 'step1', field: 'prompt' });
  });
});
