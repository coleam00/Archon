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

  test('a loop with no until round-trips exactly, and no until key is introduced (#2563)', () => {
    // Before `until` became optional the builder read it unconditionally, so a
    // deterministic-only loop threw on `undefined.trim()` in structural validation
    // and would have exported `until: undefined`.
    const deterministic: WireWorkflowDefinition = {
      name: 'deterministic-loop',
      description: 'Terminates on until_bash alone',
      nodes: [
        {
          id: 'fix',
          loop: {
            prompt: 'Fix the failing tests',
            max_iterations: 5,
            fresh_context: false,
            until_bash: 'bun run test',
          },
        },
      ],
    };

    const { workflow, issues } = fromWorkflowDefinition(deterministic);
    expect(issues).toEqual([]);
    const node = workflow.nodes[0];
    expect(node.variant).toBe('loop');
    if (node.variant === 'loop') {
      expect(node.data.until).toBeUndefined();
      expect(node.data.until_bash).toBe('bun run test');
    }

    const exported = toWorkflowDefinition(workflow);
    expect(exported).toEqual(deterministic);
    expect('until' in (exported.nodes[0].loop ?? {})).toBe(false);
  });

  test('a loop with until_field round-trips exactly, schema and all (#2563)', () => {
    // `variants/loop.ts` is a hand-written FIELD LIST, and the importer's
    // unsupported-key warning only walks top-level wire keys — anything nested in
    // `loop: {…}` is invisible to it. A channel missing from the converter is
    // therefore deleted silently on the first open-and-save, with no import issue
    // to notice: the loop would quietly fall back to another channel or stop
    // terminating. This test is the lock on that for `until_field`.
    const structured: WireWorkflowDefinition = {
      name: 'judgment-loop',
      description: 'Terminates on a validated boolean',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: {
            prompt: 'Work the backlog',
            max_iterations: 20,
            fresh_context: false,
            until_field: 'done',
          },
        },
      ],
    };

    const { workflow, issues } = fromWorkflowDefinition(structured);
    expect(issues).toEqual([]);
    const node = workflow.nodes[0];
    expect(node.variant).toBe('loop');
    if (node.variant === 'loop') {
      expect(node.data.until_field).toBe('done');
      expect(node.data.until).toBeUndefined();
    }

    // Exact equality is the assertion that matters: the schema must survive as a
    // base field and `until_field` must come back out of the converter.
    expect(toWorkflowDefinition(workflow)).toEqual(structured);
  });

  test('command-backed loop round-trips exactly — command preserved, no prompt key introduced', () => {
    const { workflow, issues } = fromWorkflowDefinition(FIXTURES.loopCommand);
    expect(issues).toEqual([]);
    const node = workflow.nodes[0];
    expect(node.variant).toBe('loop');
    if (node.variant === 'loop') {
      expect(node.data.command).toBe('refine-draft');
      expect(node.data.prompt).toBeUndefined();
    }
    const exported = toWorkflowDefinition(workflow);
    // Exact equality: `{ command }` must NOT come back as `{ prompt: '' }`.
    expect(exported).toEqual(FIXTURES.loopCommand);
    expect('prompt' in (exported.nodes[0].loop ?? {})).toBe(false);
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

  test('wait event and deadline round-trip exactly', () => {
    const definition: WireWorkflowDefinition = {
      name: 'wait-for-checks',
      description: 'waits for an external signal',
      nodes: [{ id: 'checks', wait: { event: 'checks.complete', deadline_ms: 86_400_000 } }],
    };

    const { workflow, issues } = fromWorkflowDefinition(definition);
    expect(issues).toEqual([]);
    expect(workflow.nodes[0]?.variant).toBe('wait');
    expect(toWorkflowDefinition(workflow)).toEqual(definition);
  });

  test('cleared wait fields remain drafts until server validation', () => {
    const clearedWaits = [
      { duration_ms: undefined },
      { event: 'checks.complete', deadline_ms: undefined },
    ];

    for (const data of clearedWaits) {
      const draft = toWorkflowDefinition({
        name: 'wait-draft',
        description: 'wait mode is selected before its value is entered',
        meta: {},
        nodes: [{ id: 'pause', variant: 'wait', base: {}, data }],
      });

      expect(draft.nodes).toEqual([{ id: 'pause', wait: data }]);
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

  test('a loop with both prompt and command is flagged with an error and keeps the prompt', () => {
    // Not engine-producible input (the schema enforces exactly-one) — the
    // importer must not silently drop either source.
    const { workflow, issues } = fromWorkflowDefinition(
      wire([
        {
          id: 'both',
          loop: {
            prompt: 'inline',
            command: 'cmd-file',
            until: 'DONE',
            max_iterations: 3,
            fresh_context: false,
          },
        },
      ])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].rule).toBe('structural.field.unsupported');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].path).toEqual({ nodeId: 'both', field: 'loop.command' });
    const node = workflow.nodes[0];
    expect(node.variant).toBe('loop');
    if (node.variant === 'loop') {
      expect(node.data.prompt).toBe('inline');
      expect(node.data.command).toBeUndefined();
    }
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
