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

  test.each([false, true])(
    'refuses an invalid structured result and authors no outcome (execCode: %s)',
    async execCode => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'invalid-authored-outcome',
          returns: 'verdict',
          outcome_field: 'green',
          nodes: [
            {
              id: 'verdict',
              bash: `printf '{"green":false}'`,
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
        ...(execCode ? { execCode } : { stubs: { verdict: { green: false } } }),
      });

      expect(result).toMatchObject({ outcome: 'failed', authoredOutcome: null });
      expect(result.trace[0]).toMatchObject({
        nodeId: 'verdict',
        state: 'failed',
        reason: expect.stringContaining('output_format'),
      });
    }
  );

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

  test.each([true, false])(
    'derives authored outcome from certified executed output %s',
    async succeeded => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'executed-authored-outcome',
          returns: 'verdict',
          outcome_field: 'succeeded',
          nodes: [
            {
              id: 'verdict',
              bash: `printf '{"succeeded":${String(succeeded)}}'`,
              output_format: {
                type: 'object',
                properties: { succeeded: { type: 'boolean' } },
                required: ['succeeded'],
              },
            },
          ],
        }),
        execCode: true,
        defaultStubs: true,
      });

      expect(result).toMatchObject({
        outcome: 'completed',
        authoredOutcome: succeeded ? 'succeeded' : 'failed',
      });
      expect(formatDryRunTrace(result)).toContain(
        `Authored outcome: ${succeeded ? 'succeeded' : 'failed'}`
      );
    }
  );

  test.each(
    (
      [
        { prompt: 'verdict' },
        { bash: 'echo unused' },
        { runtime: 'bun', script: 'throw new Error("must not execute");' },
      ] as const
    ).flatMap(source => [true, false].map(defaultStubs => ({ source, defaultStubs })))
  )(
    'does not author a verdict from a generated placeholder (%j)',
    async ({ source, defaultStubs }) => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'placeholder-authored-outcome',
          returns: 'verdict',
          outcome_field: 'green',
          nodes: [
            {
              id: 'verdict',
              ...source,
              ...(defaultStubs ? {} : { trigger_rule: 'all_done' }),
              output_format: {
                type: 'object',
                properties: { green: { type: 'boolean' } },
                required: ['green'],
              },
            },
          ],
        }),
        defaultStubs,
      });

      expect(result).toMatchObject({
        outcome: 'completed',
        authoredOutcome: null,
        missingStubs: defaultStubs ? [] : ['verdict'],
        toleratedMissingStubs: defaultStubs ? [] : ['verdict'],
      });
    }
  );

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

  test.each([{ items: ['a', 'b'] }, { items: [] }])(
    'a fan-out publishes its authored array in item order downstream (items: %j)',
    async ({ items }) => {
      const children = [
        { item: 'a', result: 'first' },
        { item: 'b', result: 'second' },
      ];
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'parent',
          inputs: { flag: { default: true } },
          nodes: [
            { id: 'pick', prompt: 'items' },
            {
              id: 'spread',
              workflow: 'does-not-exist',
              with: { source: '$pick.output', flag: '$INPUTS.flag', options: { strict: true } },
              depends_on: ['pick'],
              fan_out: { items: '$pick.output', max_parallel: 1, join: 'all_done' },
            },
            { id: 'after', prompt: 'Results: $spread.output', depends_on: ['spread'] },
          ],
        }),
        stubs: { pick: items, ...(items.length ? { spread: children } : {}), after: 'done' },
      });
      const expected = JSON.stringify(items.length ? children : []);
      expect(result.outcome).toBe('completed');
      expect(result.trace[1]).toMatchObject({
        nodeId: 'spread',
        state: items.length ? 'stubbed' : 'completed',
        output: expected,
      });
      expect(result.trace[2]).toMatchObject({
        nodeId: 'after',
        state: 'stubbed',
        resolvedText: `Results: ${expected}`,
      });
    }
  );

  test('an empty fan-out ignores an authored stub', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'parent',
        nodes: [{ id: 'spread', workflow: 'other', fan_out: { items: '[]' } }],
      }),
      stubs: { spread: 'unused' },
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace[0]).toMatchObject({ state: 'completed', output: '[]' });
    expect(result.unusedStubs).toEqual(['spread']);
  });

  test.each([{}, { defaultStubs: true }])(
    'a non-empty fan-out requires an authored stub (%j)',
    async options => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'parent',
          nodes: [{ id: 'spread', workflow: 'other', fan_out: { items: '["a"]' } }],
        }),
        ...options,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain('does not execute reachable workflow nodes');
    }
  );

  test.each(['stub', '[{}]', {}, null, true, 42])(
    'a fan-out rejects a non-array stub (%j)',
    async spread => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'parent',
          nodes: [{ id: 'spread', workflow: 'other', fan_out: { items: '["a"]' } }],
        }),
        stubs: { spread },
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain('must be a JSON array');
    }
  );

  test.each(['broken', '{}', '$missing.output.items'])(
    'a fan-out resolves and validates items before accepting a stub (%s)',
    async items => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'parent',
          nodes: [{ id: 'spread', workflow: 'other', fan_out: { items } }],
        }),
        stubs: { spread: [] },
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain("fan_out.items on 'spread'");
    }
  );

  test.each(['[]', '["a"]'])(
    'a fan-out resolves static bindings before completion (items: %s)',
    async items => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'parent',
          nodes: [
            {
              id: 'spread',
              workflow: 'other',
              fan_out: { items },
              with: { target: '$missing.output.field' },
            },
          ],
        }),
        stubs: { spread: [] },
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.reason).toContain("fan_out 'with:' on 'spread'");
    }
  );

  test.each([{}, { fan: [] }])(
    'fails loud on a reachable composed fan-out node even with stubs (%j)',
    async stubs => {
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
        stubs,
      });
      expect(result.outcome).toBe('failed');
      expect(result.trace[0]?.nodeType).toBe('compose_fan_out');
      expect(result.trace[0]?.reason).toContain('does not execute reachable compose_fan_out nodes');
    }
  );

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
