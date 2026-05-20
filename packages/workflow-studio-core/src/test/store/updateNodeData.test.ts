import { describe, it, expect, beforeEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';

// `description` lives in n.base (it's a workflow-level field per spec); we use
// `command` (variant-specific to command) and `provider`/`allowed_tools` (base
// fields on every variant) to exercise the routing in updateNodeData.
//
// `model_settings` is NOT in BASE_FIELD_KEYS — it lands in n.unknown via the
// pickBaseFields routing, which exercises the unknown bucket too.
//
// See docs/superpowers/plans/phase-4-drift-notes.md §2 for the storage split.

describe('builder-store.updateNodeData (deep-merge, unified routing)', () => {
  beforeEach(() => {
    useBuilderStore.getState().clearWorkflow();
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'wf', description: '', base: {}, unknown: {} },
      nodes: [
        {
          id: 'n1',
          variant: 'command',
          data: { command: 'classify', _unknown: { future_key: { nested: 'keep me' } } },
          base: { provider: 'anthropic', allowed_tools: ['Read', 'Edit', 'Bash'] },
          unknown: {},
        },
      ],
    });
  });

  it('routes a variant-specific patch into n.data, preserves _unknown', () => {
    useBuilderStore.getState().updateNodeData('n1', { command: 'review' });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect((node.data as Record<string, unknown>).command).toBe('review');
    expect((node.data as Record<string, unknown>)._unknown).toEqual({
      future_key: { nested: 'keep me' },
    });
  });

  it('routes a base-field patch into n.base without disturbing n.data', () => {
    useBuilderStore.getState().updateNodeData('n1', { provider: 'openai' });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.base.provider).toBe('openai');
    expect((node.data as Record<string, unknown>).command).toBe('classify');
  });

  it('replaces base array fields wholesale (allowed_tools is a set, not per-index)', () => {
    useBuilderStore.getState().updateNodeData('n1', { allowed_tools: ['Read'] });
    useBuilderStore.getState().updateNodeData('n1', { allowed_tools: ['Bash'] });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.base.allowed_tools).toEqual(['Bash']);
  });

  it('routes an unknown-key patch into n.unknown (forward-compat)', () => {
    useBuilderStore.getState().updateNodeData('n1', { model_settings: { temperature: 0.7 } });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.unknown.model_settings).toEqual({ temperature: 0.7 });
    // Subsequent partial patch deep-merges with the unknown bucket
    useBuilderStore.getState().updateNodeData('n1', { model_settings: { top_p: 0.9 } });
    const node2 = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node2.unknown.model_settings).toEqual({ temperature: 0.7, top_p: 0.9 });
  });

  it('null in patch deletes the key from its target bucket', () => {
    useBuilderStore.getState().updateNodeData('n1', { provider: null });
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.base.provider).toBeUndefined();
  });

  it('throws on unknown node id', () => {
    expect(() =>
      useBuilderStore.getState().updateNodeData('nope', { provider: 'openai' })
    ).toThrow();
  });
});

describe('builder-store.convertVariant (capability-aware migration)', () => {
  beforeEach(() => {
    useBuilderStore.getState().clearWorkflow();
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'wf', description: '', base: {}, unknown: {} },
      nodes: [
        {
          id: 'n1',
          variant: 'command',
          data: { command: 'classify', _unknown: {} },
          base: {
            depends_on: ['upstream'], // flow-control base — kept across any conversion
            provider: 'anthropic', // AI base — parked when target.honorsAiFields=false
            allowed_tools: ['Read'], // AI base — parked
          },
          unknown: {},
        },
      ],
    });
  });

  it('command → bash: parks command (variant-specific) and AI base fields, keeps flow-control', () => {
    useBuilderStore.getState().convertVariant('n1', 'bash');
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.variant).toBe('bash');
    // flow-control base survives
    expect(node.base.depends_on).toEqual(['upstream']);
    // AI base fields parked, removed from base
    expect(node.base.provider).toBeUndefined();
    expect(node.base.allowed_tools).toBeUndefined();
    // command (variant-specific) is no longer in data
    expect((node.data as Record<string, unknown>).command).toBeUndefined();
    // bash variant default has bash field initialised
    expect((node.data as Record<string, unknown>).bash).toBeDefined();
    // _converted_from records what was stripped, for round-trip back
    const stash = (node.data as Record<string, unknown>)._unknown as Record<string, unknown>;
    expect(stash._converted_from).toMatchObject({
      variant: 'command',
      command: 'classify',
      provider: 'anthropic',
      allowed_tools: ['Read'],
    });
  });

  it('command → prompt (both honor AI): keeps AI base fields in n.base', () => {
    useBuilderStore.getState().convertVariant('n1', 'prompt');
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(node.variant).toBe('prompt');
    expect(node.base.provider).toBe('anthropic');
    expect(node.base.allowed_tools).toEqual(['Read']);
    // command is parked since prompt doesn't accept it
    const stash = (node.data as Record<string, unknown>)._unknown as Record<string, unknown>;
    expect(stash._converted_from).toMatchObject({ variant: 'command', command: 'classify' });
    // AI base fields are NOT in _converted_from since they survived
    expect((stash._converted_from as Record<string, unknown>).provider).toBeUndefined();
  });

  it('no-op when source variant equals target', () => {
    const before = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    useBuilderStore.getState().convertVariant('n1', 'command');
    const after = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    expect(after).toEqual(before);
  });

  it('throws on unknown target variant', () => {
    expect(() => useBuilderStore.getState().convertVariant('n1', 'nonexistent' as never)).toThrow();
  });

  it('throws on unknown node id', () => {
    expect(() => useBuilderStore.getState().convertVariant('does-not-exist', 'bash')).toThrow();
  });

  it('does NOT duplicate data._unknown into n.unknown (preservation invariant)', () => {
    // Regression: pickBaseFields routes the variant-data `_unknown` key into
    // its `unknown` bucket, which previously got merged into n.unknown — the
    // forward-compat bag silently duplicated on every conversion.
    useBuilderStore.getState().clearWorkflow();
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'wf', description: '', base: {}, unknown: {} },
      nodes: [
        {
          id: 'n1',
          variant: 'command',
          data: { command: 'classify', _unknown: { foreign_subkey: 'preserve me' } },
          base: {},
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().convertVariant('n1', 'bash');
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    // data._unknown stays as the single source of truth for variant-data forward-compat.
    expect((node.data as Record<string, unknown>)._unknown).toMatchObject({
      foreign_subkey: 'preserve me',
    });
    // n.unknown (top-level forward-compat) MUST NOT contain a stray `_unknown` key.
    expect(node.unknown._unknown).toBeUndefined();
  });

  it('does NOT park mcp/skills/agents/context when converting to a non-AI variant', () => {
    // Judgment-call narrowing: a bash/script/cancel/approval node may legitimately
    // declare mcp servers and skills (those are runtime-relevant even without AI).
    // Only fields that are AI-inference-specific (provider, model, sampling knobs,
    // tool gating) get parked. context is also kept (it's data-only context, not AI).
    useBuilderStore.getState().clearWorkflow();
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'wf', description: '', base: {}, unknown: {} },
      nodes: [
        {
          id: 'n1',
          variant: 'command',
          data: { command: 'classify', _unknown: {} },
          base: {
            provider: 'anthropic', // AI-only — should park
            mcp: ['filesystem'], // runtime-relevant — should stay
            skills: ['archon-fix'], // runtime-relevant — should stay
            agents: ['planner'], // runtime-relevant — should stay
            context: { hint: 'x' }, // data-context — should stay
          },
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().convertVariant('n1', 'bash');
    const node = useBuilderStore.getState().nodes.find(n => n.id === 'n1')!;
    // Parked
    expect(node.base.provider).toBeUndefined();
    // Kept across non-AI conversion
    expect(node.base.mcp).toEqual(['filesystem']);
    expect(node.base.skills).toEqual(['archon-fix']);
    expect(node.base.agents).toEqual(['planner']);
    expect(node.base.context).toEqual({ hint: 'x' });
  });
});
