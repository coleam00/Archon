import { describe, test, expect } from 'bun:test';
import { fromWorkflowDefinition } from './from-workflow';
import { toWorkflowDefinition } from './to-workflow';
import { FIXTURES } from '../fixtures';

describe('round-trip fidelity', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`${name} fixture round-trips exactly`, () => {
      const out = toWorkflowDefinition(fromWorkflowDefinition(fixture));
      expect(out).toEqual(fixture);
    });
  }

  test('loop fresh_context is preserved across the round-trip', () => {
    const bw = fromWorkflowDefinition(FIXTURES.loop);
    const node = bw.nodes[0];
    expect(node.variant).toBe('loop');
    if (node.variant === 'loop') {
      expect(node.data.fresh_context).toBe(false);
      expect(node.data.until_bash).toBe('test -f ./done.flag');
      expect(node.data.interactive).toBe(true);
      expect(node.data.gate_message).toBe('Review the latest draft before continuing.');
    }
  });

  test('approval on_reject and capture_response survive partitioning', () => {
    const bw = fromWorkflowDefinition(FIXTURES.approval);
    const node = bw.nodes[0];
    expect(node.variant).toBe('approval');
    if (node.variant === 'approval') {
      expect(node.data.capture_response).toBe(true);
      expect(node.data.on_reject?.max_attempts).toBe(3);
    }
  });

  test('script runtime/deps/timeout survive partitioning', () => {
    const bw = fromWorkflowDefinition(FIXTURES.script);
    const node = bw.nodes[0];
    expect(node.variant).toBe('script');
    if (node.variant === 'script') {
      expect(node.data.runtime).toBe('bun');
      expect(node.data.deps).toEqual(['zod']);
      expect(node.data.timeout).toBe(30000);
    }
  });

  test('mixed fixture preserves workflow-level meta and base fields', () => {
    const bw = fromWorkflowDefinition(FIXTURES.mixed);
    expect(bw.meta.provider).toBe('claude');
    expect(bw.meta.model).toBe('sonnet');
    expect(bw.meta.tags).toEqual(['triage', 'demo']);
    const fix = bw.nodes.find(n => n.id === 'fix');
    expect(fix?.base.depends_on).toEqual(['classify']);
    expect(fix?.base.when).toBe("$classify.output == 'BUG'");
  });

  test('empty depends_on is dropped on export (engine sparse parity)', () => {
    const def = toWorkflowDefinition({
      name: 'x',
      description: 'y',
      meta: {},
      nodes: [{ id: 'a', variant: 'prompt', base: { depends_on: [] }, data: { prompt: 'hi' } }],
    });
    expect('depends_on' in def.nodes[0]).toBe(false);
  });
});
