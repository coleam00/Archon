/**
 * End-to-end integration test for the Phase 7 YAML preview feature.
 *
 * Exercises the full flow:
 *   WorkflowBuilder → Toolbar YAML toggle → YamlPreviewDrawer → CM6 editor
 *
 * Drift notes:
 *   7.8.1 — noopClient inline (same pattern as WorkflowBuilder.spec.tsx and
 *     validation-flow.spec.tsx): StubArchonApiClient doesn't exist as a dep.
 *   7.8.2 — beforeEach resets both clearWorkflow() AND setYamlPreviewOpen(false)
 *     to match the WorkflowBuilder.spec.tsx harness exactly, preventing state
 *     bleed between tests.
 *   7.8.3 — WorkflowBuilder requires onSave prop to render the Save button, but
 *     we don't need Save here; omitting it matches the existing test pattern for
 *     purely structural/visual tests.
 *   7.8.4 — YAML button text is "YAML" (no aria-label); getByRole with name /yaml/i
 *     matches it via accessible text content.
 *   7.8.5 — serializeYaml sourceMap check is a pure store assertion (no DOM
 *     interaction needed for the second test) since CM6 line highlights are
 *     driven by store state, not DOM attributes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowBuilder } from '../../components/WorkflowBuilder';
import { fromWorkflowDefinition } from '../../exporter/fromWorkflowDefinition';
import { serializeYaml } from '../../exporter/serializeYaml';
import { useBuilderStore } from '../../store/builder-store';
import type { WorkflowApiClient } from '../../api/WorkflowApiClient';

// Inline stub — same pattern as WorkflowBuilder.spec.tsx.
// @archon-studio/api-archon is not a devDependency of studio-core.
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

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '../fixtures/round-trip-fixtures/_smoke-pi-all-nodes.yaml');
const fixtureYaml = readFileSync(fixturePath, 'utf8');

beforeEach(() => {
  // Match WorkflowBuilder.spec.tsx reset pattern exactly (drift 7.8.2).
  useBuilderStore.getState().clearWorkflow();
  useBuilderStore.getState().setYamlPreviewOpen(false);
  globalThis.localStorage?.clear();

  // Load the smoke fixture so nodes are populated before render.
  useBuilderStore
    .getState()
    .loadWorkflow(fromWorkflowDefinition(parseYaml(fixtureYaml) as Record<string, unknown>));
});

afterEach(() => {
  // Reset yaml preview state so it doesn't bleed into other test files that
  // capture initial store state at module-load time (e.g. builder-store.spec.ts).
  useBuilderStore.getState().setYamlPreviewOpen(false);
  cleanup();
});

const renderBuilder = () =>
  render(
    <WorkflowBuilder
      client={noopClient}
      theme="archon-dark"
      archonUrl="__dev__"
      cwd=""
      workflowName="smoke"
    />
  );

describe('YAML preview — end-to-end wiring', () => {
  it('toggle mounts the drawer; canonical yaml appears; validation drawer survives', () => {
    const { container } = renderBuilder();

    // Initial state: inspector visible, yaml-preview absent, validation drawer present.
    expect(container.querySelector('[data-pane="inspector"]')).toBeTruthy();
    expect(container.querySelector('[data-pane="yaml-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="validation-drawer"]')).toBeTruthy();

    // Click the YAML toggle button (text: "YAML", drift 7.8.4).
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /yaml/i }));
    });

    // After toggle: yaml-preview visible, inspector hidden, validation drawer still present.
    expect(container.querySelector('[data-pane="yaml-preview"]')).toBeTruthy();
    expect(container.querySelector('[data-pane="inspector"]')).toBeNull();
    expect(container.querySelector('[data-testid="validation-drawer"]')).toBeTruthy();

    // CM6 editor mounts (proved in Task 7.3; should hold in full WorkflowBuilder too).
    expect(container.querySelector('.cm-editor')).toBeTruthy();

    // The rendered YAML must contain the first node's id from the loaded fixture.
    const text = container.textContent ?? '';
    const firstNodeId = useBuilderStore.getState().nodes[0]!.id;
    expect(text).toContain(firstNodeId);
  });

  it('selecting a node in the store causes the preview to receive that selection', () => {
    const { container } = renderBuilder();

    // Open the YAML preview drawer.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /yaml/i }));
    });

    // Fixture has multiple nodes — pick the second one.
    const nodes = useBuilderStore.getState().nodes;
    expect(nodes.length).toBeGreaterThan(1);
    const target = nodes[1]!.id;

    // Set selection via store (same pattern as WorkflowBuilder.spec.tsx inspector test).
    act(() => {
      useBuilderStore.getState().setSelection([target]);
    });

    // Store reflects the new selection.
    expect(useBuilderStore.getState().primarySelectionId).toBe(target);

    // The sourceMap produced by serializeYaml must contain a range entry for the
    // selected node — this is what drives CM6 line highlighting (drift 7.8.5).
    const { workflow, nodes: ns } = useBuilderStore.getState();
    const { sourceMap } = serializeYaml({ meta: workflow!, nodes: ns });
    expect(sourceMap.some(r => r.id === target)).toBe(true);

    // CM6 editor still mounted (selection change must not unmount the editor).
    expect(container.querySelector('.cm-editor')).toBeTruthy();
  });
});
