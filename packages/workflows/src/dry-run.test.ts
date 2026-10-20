import { describe, expect, test } from 'bun:test';
import { makeTestWorkflow } from './test-utils';
import { formatDryRunTrace } from './dry-run';
import { resolveWorkflow } from './graph-plan';
import { dryRunWorkflow } from './dry-run-test-utils';

describe('dry-run outcomes and trace', () => {
  test('reports every simulation outcome independently from authored outcome', async () => {
    const completed = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'completed',
        nodes: [{ id: 'result', prompt: 'result' }],
      }),
      stubs: { result: 'done' },
    });
    const failed = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'failed',
        nodes: [{ id: 'result', prompt: 'result' }],
      }),
    });
    const paused = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'paused',
        nodes: [{ id: 'hold', wait: { duration_ms: 60_000 } }],
      }),
    });
    const cancelled = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'cancelled',
        nodes: [{ id: 'stop', cancel: 'stop' }],
      }),
    });

    expect([completed, failed, paused, cancelled].map(result => result.outcome)).toEqual([
      'completed',
      'failed',
      'paused',
      'cancelled',
    ]);
    expect([completed, failed, paused, cancelled].map(result => result.authoredOutcome)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test.each([
    [true, 'succeeded'],
    [false, 'failed'],
  ] as const)(
    'derives authored outcome from the declared structured boolean %s',
    async (green, expected) => {
      const workflow = makeTestWorkflow({
        name: 'authored-outcome',
        returns: 'verdict',
        outcome_field: 'green',
        nodes: [
          {
            id: 'verdict',
            prompt: 'verdict',
            output_format: {
              type: 'object',
              properties: { green: { type: 'boolean' } },
              required: ['green'],
            },
          },
        ],
      });

      const result = await dryRunWorkflow({
        workflow,
        stubs: { verdict: { green } },
      });

      expect(result).toMatchObject({ outcome: 'completed', authoredOutcome: expected });
    }
  );

  test('refuses a structured result that violates its schema, and authors no outcome', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'invalid-authored-outcome',
        returns: 'verdict',
        outcome_field: 'green',
        nodes: [
          {
            id: 'verdict',
            prompt: 'verdict',
            output_format: {
              type: 'object',
              properties: {
                green: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['green', 'reason'],
            },
          },
        ],
      }),
      stubs: { verdict: { green: false } },
    });

    expect(result).toMatchObject({ outcome: 'failed', authoredOutcome: null });
    expect(result.trace[0]).toMatchObject({
      nodeId: 'verdict',
      state: 'failed',
      reason: expect.stringContaining('does not satisfy its output_format'),
    });
  });

  test('leaves authored outcome null when the declared result is not reached', async () => {
    const workflow = makeTestWorkflow({
      name: 'authored-outcome-not-reached',
      returns: 'verdict',
      outcome_field: 'green',
      nodes: [
        { id: 'hold', wait: { duration_ms: 60_000 } },
        {
          id: 'verdict',
          prompt: 'verdict',
          depends_on: ['hold'],
          output_format: {
            type: 'object',
            properties: { green: { type: 'boolean' } },
            required: ['green'],
          },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { verdict: { green: true } },
    });

    expect(result).toMatchObject({ outcome: 'paused', authoredOutcome: null });
  });

  test('does not infer authored outcome from serialized text', async () => {
    const workflow = makeTestWorkflow({
      name: 'authored-outcome-text',
      returns: 'verdict',
      outcome_field: 'green',
      nodes: [
        {
          id: 'verdict',
          bash: 'printf \'{"green":true}\'',
          output_format: {
            type: 'object',
            properties: { green: { type: 'boolean' } },
            required: ['green'],
          },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      execCode: true,
    });

    expect(result).toMatchObject({ outcome: 'completed', authoredOutcome: null });
    expect(result.trace[0]?.output).toBe('{"green":true}');
  });

  test('does not treat generated placeholders as authored fixture values', async () => {
    const workflow = (name: string, triggerRule?: 'all_done') =>
      makeTestWorkflow({
        name,
        returns: 'verdict',
        outcome_field: 'green',
        nodes: [
          {
            id: 'verdict',
            prompt: 'verdict',
            ...(triggerRule ? { trigger_rule: triggerRule } : {}),
            output_format: {
              type: 'object',
              properties: { green: { type: 'boolean' } },
              required: ['green'],
            },
          },
        ],
      });

    const defaulted = await dryRunWorkflow({
      workflow: workflow('defaulted-authored-outcome'),
      defaultStubs: true,
    });
    const tolerated = await dryRunWorkflow({
      workflow: workflow('tolerated-authored-outcome', 'all_done'),
    });

    expect(defaulted).toMatchObject({ outcome: 'completed', authoredOutcome: null });
    expect(tolerated).toMatchObject({
      outcome: 'completed',
      authoredOutcome: null,
      missingStubs: ['verdict'],
      toleratedMissingStubs: ['verdict'],
    });
  });

  test('uses the attached plan for trace order and summary selection', async () => {
    const workflow = resolveWorkflow(
      makeTestWorkflow({
        name: 'authoritative-plan',
        nodes: [
          { id: 'first', prompt: 'first' },
          { id: 'second', prompt: 'second' },
        ],
      })
    );
    const [first, second] = workflow.nodes;
    if (first === undefined || second === undefined) throw new Error('invalid test workflow');

    // Deliberately vary both decisions so either production read becoming a
    // recomputation makes this regression fail.
    Reflect.set(workflow.plan, 'layers', [[second], [first]]);
    Reflect.set(workflow.plan, 'sinks', ['second']);

    const result = await dryRunWorkflow({
      workflow,
      stubs: { first: 'first output', second: 'second output' },
    });

    expect(result.trace.map(entry => entry.nodeId)).toEqual(['second', 'first']);
    expect(result.summary).toBe('second output');
  });
  test('represents cancellation and unsupported subworkflows visibly', async () => {
    const cancelled = makeTestWorkflow({
      name: 'cancel',
      nodes: [
        { id: 'stop', cancel: 'not safe' },
        { id: 'later', prompt: 'later', depends_on: ['stop'] },
      ],
    });
    const cancelledResult = await dryRunWorkflow({
      workflow: cancelled,
    });
    expect(cancelledResult.outcome).toBe('cancelled');
    expect(cancelledResult.trace).toHaveLength(1);

    const child = makeTestWorkflow({ name: 'child', nodes: [{ id: 'child', workflow: 'other' }] });
    const childResult = await dryRunWorkflow({
      workflow: child,
    });
    expect(childResult).toMatchObject({ outcome: 'failed' });
    expect(childResult.trace[0]?.reason).toContain('does not execute reachable workflow nodes');
  });

  test('a stubbed child workflow node completes with the stub as its output', async () => {
    const workflow = makeTestWorkflow({
      name: 'parent',
      nodes: [
        { id: 'pick', bash: 'echo 7' },
        { id: 'child', workflow: 'other', with: { target: '$pick.output' }, depends_on: ['pick'] },
        {
          id: 'after',
          bash: 'echo next',
          depends_on: ['child'],
          when: '$child.output.merged == true',
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { pick: '7', child: { merged: true }, after: 'next' },
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'child')).toMatchObject({
      nodeType: 'workflow',
      state: 'stubbed',
    });
    expect(result.trace.find(entry => entry.nodeId === 'after')?.state).toBe('stubbed');
  });

  test('a stubbed child workflow node still fails on a binding a real launch would reject', async () => {
    const workflow = makeTestWorkflow({
      name: 'parent',
      nodes: [{ id: 'child', workflow: 'other', with: { target: '$missing.output' } }],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { child: { merged: true } },
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]).toMatchObject({ nodeId: 'child', state: 'failed' });
  });

  test('a --default-stubs placeholder never stands in for a child workflow run', async () => {
    const workflow = makeTestWorkflow({
      name: 'parent',
      nodes: [{ id: 'child', workflow: 'other' }],
    });
    const result = await dryRunWorkflow({
      workflow,
      defaultStubs: true,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.reason).toContain('does not execute reachable workflow nodes');
  });

  test('a fan-out child workflow node cannot be stubbed and still fails loud', async () => {
    const workflow = makeTestWorkflow({
      name: 'parent',
      nodes: [
        {
          id: 'spread',
          workflow: 'other',
          fan_out: { items: '["a"]', max_parallel: 1, join: 'all_done' },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { spread: 'stub' },
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.reason).toContain('does not execute reachable workflow nodes');
  });

  test('fails loud on a reachable composed fan-out node instead of simulating it', async () => {
    const workflow = makeTestWorkflow({
      name: 'compose-fan',
      nodes: [
        {
          id: 'fan',
          kind: 'compose_fan_out',
          include: 'some-block',
          fan_out: { items: "['a']", as: 'item', max_parallel: 1 },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
    });
    expect(result.outcome).toBe('failed');
    expect(result.trace[0]?.nodeType).toBe('compose_fan_out');
    expect(result.trace[0]?.reason).toContain('does not execute reachable compose_fan_out nodes');
  });

  test('formats a stable human trace', async () => {
    const workflow = makeTestWorkflow({ name: 'format', nodes: [{ id: 'node', prompt: 'hello' }] });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { node: 'world' },
    });

    expect(formatDryRunTrace(result)).toContain('STUBBED   node (prompt)');
    expect(formatDryRunTrace(result)).toContain('Simulation outcome: completed');
    expect(formatDryRunTrace(result)).toContain('Authored outcome: undeclared');
  });
});
