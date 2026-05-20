/**
 * End-to-end integration test for the Phase 6 validation pipeline.
 *
 * Exercises the full flow:
 *   WorkflowBuilder → useValidation → ValidationEngine → ValidationPanel + Save gate
 *
 * Drift adaptations vs. plan:
 *   6.9.1 — StubArchonApiClient not used: @archon-studio/api-archon is not a
 *     devDependency of @archon-studio/core. Inline stub (same pattern as
 *     WorkflowBuilder.spec.tsx and useValidation.spec.tsx) avoids a phantom dep.
 *   6.9.2 — WorkflowMeta needs base:{} + unknown:{}: plan's `{ name, description }`
 *     shape is missing both (drift 6.5.2 precedent in useValidation.spec.tsx).
 *   6.9.3 — BuilderNode.base holds depends_on: plan used root-level depends_on
 *     on the node, but BuilderNode stores dependency edges under node.base.
 *     toWorkflowDefinition spreads n.base flat, so the cycle rule sees them.
 *   6.9.4 — Panel starts collapsed: ValidationPanel rendered by WorkflowBuilderInner
 *     starts with expanded=false. Cycle message text is only in the DOM when
 *     expanded. Strategy: waitFor the count pill ("2 errors"), click expand, then
 *     assert /cycle/i text. The pill is always rendered in the collapsed bar.
 *   6.9.5 — beforeAll GlobalRegistrator guard: setup.ts registers happy-dom before
 *     any module runs (preload), so the guard is a no-op but kept for safety.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { WorkflowBuilder } from '../../components/WorkflowBuilder';
import { useBuilderStore } from '../../store/builder-store';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

// Inline stub — same pattern as WorkflowBuilder.spec.tsx (noopClient).
// @archon-studio/api-archon's StubArchonApiClient requires a loadFixture option;
// we don't need fixture loading here and the package is not a dep of studio-core.
const noopClient: WorkflowApiClient = {
  ping: async () => ({ ok: true }),
  listCodebases: async () => null,
  listWorkflows: async () => [],
  listCommands: async () => [],
  listProviders: async () => [],
  getWorkflow: async () => ({ name: 'noop', description: '', nodes: [] }) as never,
  saveWorkflow: async (_n, _c, d) => d,
  deleteWorkflow: async () => undefined,
  validateWorkflow: async () => ({ valid: true }),
};

beforeAll(() => {
  // setup.ts (preload) already registers — this guard is a no-op in normal runs.
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

beforeEach(() => {
  useBuilderStore.getState().clearWorkflow();
  globalThis.localStorage?.clear();
});

afterEach(() => cleanup());

describe('validation flow integration', () => {
  it('cycle blocks save; fixing the cycle unblocks it', async () => {
    render(
      <WorkflowBuilder
        client={noopClient}
        theme="archon-dark"
        workflowName="w"
        archonUrl=""
        cwd=""
        onSave={() => {}}
      />
    );

    // Load a 2-node cycle: a depends_on b, b depends_on a.
    // Drift 6.9.2: WorkflowMeta needs base:{} + unknown:{}.
    // Drift 6.9.3: depends_on lives in BuilderNode.base (not root).
    act(() => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [
          {
            id: 'a',
            variant: 'prompt',
            data: { prompt: 'x' },
            base: { depends_on: ['b'] },
            unknown: {},
          },
          {
            id: 'b',
            variant: 'prompt',
            data: { prompt: 'x' },
            base: { depends_on: ['a'] },
            unknown: {},
          },
        ],
      });
    });

    // Wait for debounce (300 ms) to fire and emit cycle issues.
    // Drift 6.9.4: Panel starts collapsed — assert on the Pill count text in the
    // collapsed summary bar, which is always rendered.
    await waitFor(() => expect(screen.getByText(/2 errors/i)).toBeTruthy(), { timeout: 1000 });

    // Save button must be disabled while errors are present.
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(
      true
    );

    // Expand the panel to confirm the cycle message appears in the issue list.
    // Use getAllByText because both the rule name ("graph.cycle") and message text
    // ("is part of a cycle in depends_on") match /cycle/i — at least one is enough.
    fireEvent.click(screen.getByRole('button', { name: /expand validation panel/i }));
    expect(screen.getAllByText(/cycle/i).length).toBeGreaterThan(0);

    // Fix the cycle: remove b's back-edge to a.
    // useBuilderStore.setState triggers useValidation's [nodes] effect → engine.update().
    act(() => {
      useBuilderStore.setState(s => ({
        nodes: s.nodes.map(n => (n.id === 'b' ? { ...n, base: { ...n.base, depends_on: [] } } : n)),
      }));
    });

    // After the next debounce cycle, there are no more errors → Save is re-enabled.
    await waitFor(
      () =>
        expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(
          false
        ),
      { timeout: 1000 }
    );
  });
});
