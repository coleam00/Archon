import { describe, test, expect } from 'bun:test';
import { fromWorkflowDefinition } from './from-workflow';
import { toWorkflowDefinition } from './to-workflow';
import { FIXTURES } from '../fixtures';
import type { WireWorkflowDefinition } from '../types';

describe('round-trip fidelity', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`${name} fixture round-trips exactly`, () => {
      const { workflow, issues } = fromWorkflowDefinition(fixture);
      expect(issues).toEqual([]);
      expect(toWorkflowDefinition(workflow)).toEqual(fixture);
    });
  }

  test('loop fresh_context is preserved across the round-trip', () => {
    const bw = fromWorkflowDefinition(FIXTURES.loop).workflow;
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
    const bw = fromWorkflowDefinition(FIXTURES.approval).workflow;
    const node = bw.nodes[0];
    expect(node.variant).toBe('approval');
    if (node.variant === 'approval') {
      expect(node.data.capture_response).toBe(true);
      expect(node.data.on_reject?.max_attempts).toBe(3);
    }
  });

  test('script runtime/deps/timeout survive partitioning', () => {
    const bw = fromWorkflowDefinition(FIXTURES.script).workflow;
    const node = bw.nodes[0];
    expect(node.variant).toBe('script');
    if (node.variant === 'script') {
      expect(node.data.runtime).toBe('bun');
      expect(node.data.deps).toEqual(['zod']);
      expect(node.data.timeout).toBe(30000);
    }
  });

  test('mixed fixture preserves workflow-level meta and base fields', () => {
    const bw = fromWorkflowDefinition(FIXTURES.mixed).workflow;
    expect(bw.meta.provider).toBe('claude');
    expect(bw.meta.model).toBe('sonnet');
    expect(bw.meta.tags).toEqual(['triage', 'demo']);
    const fix = bw.nodes.find(n => n.id === 'fix');
    expect(fix?.base.depends_on).toEqual(['classify']);
    expect(fix?.base.when).toBe("$classify.output == 'BUG'");
    expect(fix?.base.persist_session).toBe(true);
    const classify = bw.nodes.find(n => n.id === 'classify');
    expect(classify?.base.output_type).toBe('classification');
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

describe('import issues', () => {
  const wire = (nodes: WireWorkflowDefinition['nodes']): WireWorkflowDefinition => ({
    name: 'w',
    description: 'd',
    nodes,
  });

  test('a node with no mode field imports as an empty prompt node with an error', () => {
    const { workflow, issues } = fromWorkflowDefinition(wire([{ id: 'mystery' }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('structural.variant.unknown');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].path.nodeId).toBe('mystery');
    const node = workflow.nodes[0];
    expect(node.variant).toBe('prompt');
    if (node.variant === 'prompt') expect(node.data.prompt).toBe('');
  });

  test('a script node missing runtime is flagged but stays editable as bun', () => {
    const { workflow, issues } = fromWorkflowDefinition(
      wire([{ id: 's', script: 'console.log(1)' }])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('structural.field.missing');
    expect(issues[0].path).toEqual({ nodeId: 's', field: 'runtime' });
    const node = workflow.nodes[0];
    expect(node.variant).toBe('script');
    if (node.variant === 'script') expect(node.data.runtime).toBe('bun');
  });

  test('a wire key the variant cannot carry is dropped with a warning, matching the engine', () => {
    // The engine's transform emits `timeout` only on bash/script nodes, so a
    // prompt node carrying one is not engine-producible input; the importer
    // drops it loudly rather than silently.
    const { workflow, issues } = fromWorkflowDefinition(
      wire([{ id: 'p', prompt: 'hi', timeout: 5000 }])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('structural.field.unsupported');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].path).toEqual({ nodeId: 'p', field: 'timeout' });
    const out = toWorkflowDefinition(workflow);
    expect('timeout' in out.nodes[0]).toBe(false);
  });

  test('timeout on bash and script nodes is carried, not flagged', () => {
    const { issues } = fromWorkflowDefinition(
      wire([
        { id: 'b', bash: 'echo hi', timeout: 1000 },
        { id: 's', script: 'x', runtime: 'uv', timeout: 2000 },
      ])
    );
    expect(issues).toEqual([]);
  });
});

describe('fromDag fail-fast contract', () => {
  test('every fromDag throws when its mode field is absent', async () => {
    const { VARIANT_REGISTRY } = await import('../variants');
    for (const entry of Object.values(VARIANT_REGISTRY)) {
      expect(() => entry.fromDag({})).toThrow(/has no '.+' field/);
    }
  });
});
