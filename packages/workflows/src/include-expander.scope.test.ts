import { describe, test, expect } from 'bun:test';
import { expandWorkflowIncludes } from './include-expander';
import type { WorkflowDefinition } from './schemas';
import type { DagNode } from './schemas';
import { wf, mapOf, nodeById } from './include-expander.fixtures';

describe('expandWorkflowIncludes — where a workflow-level model: travels (#1764)', () => {
  const collapse = (w: WorkflowDefinition): DagNode[] =>
    expandWorkflowIncludes(mapOf(w)).workflows.get(w.name)!.nodes as DagNode[];

  test('travels to a node that declares no provider of its own', () => {
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(nodes[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  test('travels to a node that redundantly re-declares the SAME provider', () => {
    // The branch a regression would most plausibly drop, and a common authoring habit.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'codex' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(nodes[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  test('does NOT travel to a node that switches provider', () => {
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'claude' }]),
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].model).toBeUndefined();
  });

  test('does NOT travel when the workflow declares a model but no provider — the known divergence', () => {
    // Pinned deliberately: the pre-collapse chain compared the node against the RESOLVED
    // workflow provider, so a tier resolving to `codex` DID reach a `provider: codex`
    // node. Load time cannot resolve tiers (they depend on the acting user's prefs), so
    // the model stays behind and the node uses its own provider's configured default.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'codex' }]),
      model: 'large',
    });
    expect(nodes[0]?.model).toBeUndefined();
    expect(nodes[0]?.provider).toBe('codex');
  });

  test('every other node-affecting field travels regardless of the node provider', () => {
    // `model` alone carries a provider condition, because it alone is a provider-specific
    // string the executor already refused to inherit across providers. `effort`/`sandbox`/
    // `betas`/`fallbackModel` had no such condition before the collapse and must
    // not gain one, or the collapse stops being behaviour-preserving.
    const nodes = collapse({
      ...wf('w', [{ id: 'n', prompt: 'p', provider: 'claude' }]),
      provider: 'codex',
      effort: 'high',
      sandbox: { enabled: true },
      betas: ['beta-x'],
      fallbackModel: 'fallback-1',
    });
    expect(nodes[0]).toMatchObject({
      effort: 'high',
      sandbox: { enabled: true },
      betas: ['beta-x'],
      fallbackModel: 'fallback-1',
    });
  });
});

describe('include-free workflow scope', () => {
  test('include-free workflows are collapsed too, so composition cannot change behaviour', () => {
    // There is no byte-for-byte fast path any more (#1764). Collapsing only workflows that
    // happen to contain an `include:` would make a workflow's own nodes resolve differently
    // depending on an unrelated authoring choice, which is the defect this fixes.
    const plain: WorkflowDefinition = {
      ...wf('plain', [
        { id: 'a', prompt: 'a' },
        { id: 'b', prompt: 'b', provider: 'codex' },
      ]),
      provider: 'pi',
      model: 'large',
    };
    const { workflows, errors } = expandWorkflowIncludes(mapOf(plain));
    expect(errors).toHaveLength(0);

    const expanded = workflows.get('plain')!;
    expect(expanded).not.toBe(plain);
    expect(expanded.provider).toBeUndefined();
    expect(expanded.model).toBeUndefined();
    expect(nodeById(expanded, 'a')).toMatchObject({ provider: 'pi', model: 'large' });
    // The node's own value always wins over the workflow's — and a node that switches
    // provider does NOT inherit the other provider's model string, matching what the
    // executor does with a workflow-level model today.
    expect(nodeById(expanded, 'b')).toMatchObject({ provider: 'codex' });
    expect(nodeById(expanded, 'b')?.model).toBeUndefined();
    // The input is never mutated — discovery hands the same object to display surfaces.
    expect(plain.provider).toBe('pi');
  });
});
