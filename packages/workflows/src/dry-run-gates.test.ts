import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestWorkflow } from './test-utils';
import { formatDryRunTrace, type DryRunStubValue } from './dry-run';
import { dryRunWorkflow, createDryRunStubScaffold, useDryRunFiles } from './dry-run-test-utils';

const { temporaryDirectory } = useDryRunFiles();

describe('dry-run gates and waits', () => {
  test('auto-approves or pauses approval gates', async () => {
    const workflow = makeTestWorkflow({
      name: 'approval',
      nodes: [
        { id: 'before', prompt: 'before' },
        { id: 'gate', approval: { message: 'Review $before.output' }, depends_on: ['before'] },
        { id: 'after', prompt: 'after', depends_on: ['gate'] },
      ],
    });
    const automatic = await dryRunWorkflow({
      workflow,
      stubs: { before: 'result', after: 'done' },
    });
    expect(automatic.trace.find(entry => entry.nodeId === 'gate')).toMatchObject({
      state: 'completed',
      reason: 'auto-approved',
    });

    const paused = await dryRunWorkflow({
      workflow,
      stubs: { before: 'result', after: 'unused' },
      pauseAtGates: true,
    });
    expect(paused.outcome).toBe('paused');
    expect(paused.trace.at(-1)).toMatchObject({ nodeId: 'gate', state: 'paused' });
    expect(paused.unusedStubs).toEqual(['after']);
  });

  test('a gate inside a loop_group body pauses the whole run', async () => {
    const workflow = makeTestWorkflow({
      name: 'gate-in-loop-group',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until_bash: 'exit 0',
            max_iterations: 2,
            nodes: [
              { id: 'work', prompt: 'p' },
              { id: 'gate', approval: { message: 'ok?' }, depends_on: ['work'] },
            ],
          },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { work: 'done' },
      pauseAtGates: true,
    });

    expect(result.outcome).toBe('paused');
  });

  test('reports a durable wait as a pause without AI resolution', async () => {
    const workflow = makeTestWorkflow({
      name: 'wait',
      nodes: [{ id: 'delay', wait: { duration_ms: 60_000 } }],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: {},
    });

    expect(result.outcome).toBe('paused');
    expect(createDryRunStubScaffold(workflow)).toEqual({});
    expect(result.trace).toEqual([
      {
        nodeId: 'delay',
        nodeType: 'wait',
        state: 'paused',
        reason: 'durable wait',
      },
    ]);
    expect(result.missingStubs).toEqual([]);
    expect(result.unusedStubs).toEqual([]);
  });

  test('resolves an attention wait message before pausing', async () => {
    const workflow = makeTestWorkflow({
      name: 'attention-wait',
      nodes: [
        { id: 'probe', bash: 'printf failed' },
        {
          id: 'recover',
          wait: { attention: 'Rerun $probe.output, then resume $INPUTS.run_label.' },
          depends_on: ['probe'],
        },
      ],
      inputs: { run_label: { default: 'this run' } },
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { probe: 'e2e-smoke (fail)' },
    });

    expect(result.outcome).toBe('paused');
    expect(result.trace.at(-1)).toMatchObject({
      nodeId: 'recover',
      state: 'paused',
      resolvedText: 'Rerun e2e-smoke (fail), then resume this run.',
    });
  });

  test.each([
    {
      name: 'an unoffered recommendation',
      declaration: {
        recommendation: '$decide.output.recommendation',
      },
      options: [{ id: 'hold' }],
      expected: "'recommendation' names option 'ship', which the wait does not offer",
    },
    {
      name: 'duplicate option ids',
      declaration: {},
      options: [{ id: 'hold' }, { id: 'hold' }],
      expected: "'hold' is declared more than once",
    },
    {
      name: "an option using the reserved 'other' id",
      declaration: { other: true },
      options: [{ id: 'other' }],
      expected: "option id 'other' is reserved when 'other: true' is set",
    },
    {
      name: 'an empty question',
      declaration: {},
      options: [{ id: 'hold' }],
      expected: "resolved 'attention' to an empty message",
    },
  ])(
    'refuses $name with and without an answer stub',
    async ({ declaration, options, expected }) => {
      for (const answered of [false, true]) {
        const result = await dryRunWorkflow({
          workflow: makeTestWorkflow({
            name: 'invalid-attention-ask',
            nodes: [
              { id: 'decide', bash: 'unused' },
              {
                id: 'ask',
                depends_on: ['decide'],
                wait: {
                  attention: '$decide.output.question',
                  form: 'select',
                  options: '$decide.output.options',
                  ...declaration,
                },
              },
            ],
          }),
          stubs: {
            decide: {
              question: expected.includes('empty message') ? '' : 'Merge it?',
              options,
              recommendation: { option: 'ship', why: 'Not offered.' },
            },
            ...(answered ? { ask: { decision: 'hold', text: '' } } : {}),
          },
        });

        expect(result.outcome, `answered=${String(answered)}`).toBe('failed');
        const failure = result.trace.find(entry => entry.state === 'failed');
        expect(failure, `answered=${String(answered)}`).toMatchObject({
          nodeId: 'ask',
          nodeType: 'wait',
          reason: expect.stringContaining(expected),
        });
      }
    }
  );

  test('shows the complete resolved ask when it pauses or is answered', async () => {
    const workflow = makeTestWorkflow({
      name: 'resolved-attention-ask',
      nodes: [
        { id: 'decide', bash: 'unused' },
        {
          id: 'ask',
          depends_on: ['decide'],
          wait: {
            attention: '$decide.output.question',
            form: 'select',
            options: '$decide.output.options',
            recommendation: '$decide.output.recommendation',
            labels: { stage: 'deliver', area: '$decide.output.area' },
            other: true,
          },
        },
      ],
    });
    const decide = {
      question: 'Merge it?',
      options: [{ id: 'merge', label: 'Merge' }],
      recommendation: { option: 'merge', why: 'Review is ready.', confidence: 'high' },
      area: 'delivery',
    };
    const attentionAsk = {
      form: 'select',
      options: [
        { id: 'merge', label: 'Merge' },
        {
          id: 'other',
          label: 'Other',
          does: 'None of these. The answer text says what to do instead.',
        },
      ],
      recommendation: { option: 'merge', why: 'Review is ready.', confidence: 'high' },
      labels: { stage: 'deliver', area: 'delivery' },
      other: true,
    };

    for (const answered of [false, true]) {
      const result = await dryRunWorkflow({
        workflow,
        stubs: {
          decide,
          ...(answered ? { ask: { decision: 'merge', text: 'go' } } : {}),
        },
      });
      expect(result.outcome, `answered=${String(answered)}`).toBe(
        answered ? 'completed' : 'paused'
      );
      expect(result.trace.at(-1), `answered=${String(answered)}`).toMatchObject({
        nodeId: 'ask',
        state: answered ? 'stubbed' : 'paused',
        resolvedText: 'Merge it?',
        attentionAsk,
      });
    }
    expect(formatDryRunTrace(await dryRunWorkflow({ workflow, stubs: { decide } }))).toContain(
      '"area":"delivery"'
    );
  });

  test('a pure-stub attention wait creates no scratch directory', async () => {
    const home = temporaryDirectory();
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    try {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'stub-only-attention',
          nodes: [
            {
              id: 'ask',
              wait: { attention: 'Merge it?', form: 'select', options: [{ id: 'merge' }] },
            },
          ],
        }),
        stubs: { ask: { decision: 'merge', text: '' } },
        execCode: true,
      });

      expect(result.outcome).toBe('completed');
      expect(existsSync(join(home, 'temp'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  test.each([
    { inputs: undefined, previewed: 'Prior was null.' },
    { inputs: { prior: 'supplied' }, previewed: 'Prior was supplied.' },
  ])(
    'previews an unsupplied result_of input as null, a supplied one as given (%j)',
    async ({ inputs, previewed }) => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'reader',
          inputs: { prior: { result_of: 'build' } },
          nodes: [{ id: 'recover', wait: { attention: 'Prior was $INPUTS.prior.' } }],
        }),
        ...(inputs ? { inputs } : {}),
      });

      expect(result.outcome).toBe('paused');
      expect(result.trace.at(-1)).toMatchObject({ nodeId: 'recover', resolvedText: previewed });
    }
  );

  test('gate messages, cancel reasons and wait messages keep $ARGUMENTS literal, as a real run renders them', async () => {
    const preview = async (node: Record<string, unknown>): Promise<string | undefined> => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'literal-arguments',
          nodes: [{ id: 'step', ...node } as never],
        }),
        userMessage: 'secret user text',
        pauseAtGates: true,
      });
      return result.trace.find(entry => entry.nodeId === 'step')?.resolvedText;
    };

    expect(await preview({ approval: { message: 'Approve $ARGUMENTS?' } })).toBe(
      'Approve $ARGUMENTS?'
    );
    expect(await preview({ cancel: 'Stopped for $ARGUMENTS' })).toBe('Stopped for $ARGUMENTS');
    expect(await preview({ wait: { attention: 'Look at $ARGUMENTS' } })).toBe('Look at $ARGUMENTS');
  });

  test('a stub answers an attention wait and routes on its decision', async () => {
    const workflow = makeTestWorkflow({
      name: 'attention-answer',
      nodes: [
        { id: 'review', wait: { attention: 'Post it?', form: 'approval' } },
        {
          id: 'post',
          bash: 'echo $review.output.text',
          depends_on: ['review'],
          when: "$review.output.decision == 'approve'",
        },
        {
          id: 'stop',
          cancel: 'rejected',
          depends_on: ['review'],
          when: "$review.output.decision == 'reject'",
        },
      ],
    });
    const run = (answer: DryRunStubValue) =>
      dryRunWorkflow({
        workflow,
        stubs: { review: answer, post: 'posted' },
      });

    const approved = await run({ decision: 'approve', text: 'ship it' });
    expect(approved.outcome).toBe('completed');
    expect(approved.trace[0]).toMatchObject({
      nodeId: 'review',
      state: 'stubbed',
      reason: 'answered by stub',
      resolvedText: 'Post it?',
    });

    const rejected = await run({ decision: 'reject', text: '' });
    expect(rejected.outcome).toBe('cancelled');
    expect(rejected.trace.find(step => step.nodeId === 'post')?.state).toBe('skipped');

    const invalid = await run({ decision: 'maybe', text: '' });
    expect(invalid.outcome).toBe('failed');
  });

  test('a stub answer chooses only the options its wait declares', async () => {
    const options = [{ id: 'use-main' }, { id: 'use-dev' }];
    const outcome = async (form: 'select' | 'multi_select', answer: DryRunStubValue) => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'attention-options',
          nodes: [{ id: 'ask', wait: { attention: 'Which base?', form, options } }],
        }),
        stubs: { ask: answer },
      });
      return { outcome: result.outcome, reason: result.trace[0]?.reason };
    };

    expect((await outcome('select', { decision: 'use-dev', text: '' })).outcome).toBe('completed');
    expect(await outcome('select', { decision: 'unknown', text: '' })).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining("does not declare option 'unknown'"),
    });
    expect(
      (await outcome('multi_select', { decisions: ['use-main', 'use-dev'], text: '' })).outcome
    ).toBe('completed');
    expect(await outcome('multi_select', { decisions: [], text: '' })).toMatchObject({
      outcome: 'failed',
      reason: expect.stringContaining('needs at least one option'),
    });
    expect(
      await outcome('multi_select', { decisions: ['use-main', 'use-main'], text: '' })
    ).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('at most once') });
  });

  test("a stub answer to a select wait carries the chosen option's value, as the real wait returns", async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'attention-value',
        nodes: [
          {
            id: 'ask',
            wait: {
              attention: 'Merge it?',
              form: 'select',
              options: [{ id: 'merge', value: { effect: 'merge' } }, { id: 'hold' }],
              recommendation: { option: 'merge', why: 'Review is ready.' },
            },
          },
        ],
      }),
      stubs: { ask: { decision: 'merge', text: '' } },
    });

    expect(result.outcome).toBe('completed');
    expect(JSON.parse(String(result.trace[0]?.output))).toEqual({
      decision: 'merge',
      text: '',
      value: { effect: 'merge' },
    });
  });

  test('validates stub answers against options from simulated upstream output', async () => {
    const run = (options: DryRunStubValue, decision: string) =>
      dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'dynamic-attention-options',
          nodes: [
            { id: 'choices', bash: 'unused' },
            {
              id: 'ask',
              depends_on: ['choices'],
              wait: {
                attention: 'Which base?',
                form: 'select',
                options: '$choices.output.options',
              },
            },
          ],
        }),
        stubs: { choices: { options }, ask: { decision, text: '' } },
      });

    expect((await run([{ id: 'use-dev' }], 'use-dev')).outcome).toBe('completed');
    const undeclared = await run([{ id: 'use-dev' }], 'unknown');
    expect(undeclared.outcome).toBe('failed');
    expect(undeclared.trace.at(-1)?.reason).toContain("does not declare option 'unknown'");
    const invalid = await run([{ id: 'duplicate' }, { id: 'duplicate' }], 'duplicate');
    expect(invalid.outcome).toBe('failed');
    expect(invalid.trace.at(-1)?.reason).toContain('not a valid option list');
  });

  test('a failed outer node with the terminal wait id does not suppress a clean body pause', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'outer-failure',
        nodes: [
          { id: 'pause', prompt: 'Missing stub' },
          {
            id: 'group',
            depends_on: ['pause'],
            trigger_rule: 'all_done',
            loop_group: {
              until_bash: 'exit 1',
              max_iterations: 1,
              nodes: [{ id: 'pause', wait: { attention: 'Please decide' } }],
            },
          },
        ],
      }),
      userMessage: '',
      cwd: process.cwd(),
    });
    expect(result.outcome).toBe('paused');
    expect(result.trace.at(-1)).toMatchObject({ nodeId: 'pause', state: 'paused' });
  });
});

for (const { name, suspension, nesting, topology } of [
  {
    name: 'gate',
    nesting: 'direct',
    topology: 'sole sink',
    suspension: { approval: { message: 'Please decide' } },
  },
  {
    name: 'wait',
    nesting: 'direct',
    topology: 'sole sink',
    suspension: { wait: { attention: 'Please decide' } },
  },
  ...(
    [
      ['gate', { approval: { message: 'Please decide' } }],
      [
        'interactive group',
        {
          loop_group: {
            max_iterations: 1,
            until_bash: 'exit 1',
            interactive: true,
            gate_message: 'Please decide',
            nodes: [{ id: 'task', bash: 'echo done' }],
          },
        },
      ],
      [
        'interactive loop',
        {
          loop: {
            max_iterations: 1,
            until: 'DONE',
            interactive: true,
            gate_message: 'Please decide',
            prompt: 'Work',
          },
        },
      ],
    ] as const
  ).flatMap(
    ([name, sink]) =>
      [
        {
          name,
          nesting: 'nested',
          topology: 'sole sink',
          suspension: {
            loop_group: {
              max_iterations: 1,
              until_bash: 'exit 1',
              nodes: [{ id: 'check', ...sink }],
            },
          },
        },
        ...(['sole sink', 'before exec', 'beside exec'] as const).map(
          topology =>
            ({
              name,
              nesting: 'recursive',
              topology,
              suspension: {
                loop_group: {
                  max_iterations: 1,
                  until_bash: 'exit 1',
                  nodes: [
                    {
                      id: 'nested',
                      loop_group: {
                        max_iterations: 1,
                        until_bash: 'exit 1',
                        nodes: [{ id: 'check', ...sink }],
                      },
                    },
                    ...(topology === 'sole sink'
                      ? []
                      : [
                          {
                            id: 'finish',
                            bash: 'echo done',
                            depends_on: topology === 'before exec' ? ['nested'] : [],
                          },
                        ]),
                  ],
                },
              },
            }) as const
        ),
      ] as const
  ),
] as const) {
  const label =
    nesting === 'direct'
      ? name
      : `${nesting} ${name}${nesting === 'recursive' ? ` ${topology}` : ''}`;
  for (const outerTopology of [
    'sole sink',
    ...(nesting !== 'direct' && topology === 'sole sink' ? ['before exec', 'beside exec'] : []),
  ]) {
    for (const failed of nesting !== 'direct' ? [true] : [true, false]) {
      test(`loop-group ${label} outer ${outerTopology} ${failed ? 'yields to a body failure' : 'pauses after a clean body'}`, async () => {
        const workflow = makeTestWorkflow({
          name: 'failure-before-suspension',
          nodes: [
            {
              id: 'group',
              loop_group: {
                until_bash: 'exit 1',
                max_iterations: 2,
                nodes: [
                  { id: 'work', prompt: 'Work' },
                  {
                    id: 'cleanup',
                    bash: 'echo cleanup',
                    depends_on: ['work'],
                    trigger_rule: 'all_done',
                  },
                  {
                    id: 'pause',
                    ...suspension,
                    depends_on: ['cleanup'],
                    trigger_rule: 'all_done',
                  },
                  ...(outerTopology === 'sole sink'
                    ? []
                    : [
                        {
                          id: 'outer-finish',
                          bash: 'echo done',
                          depends_on: outerTopology === 'before exec' ? ['pause'] : ['cleanup'],
                          trigger_rule: 'all_done',
                        },
                      ]),
                ],
              },
            },
          ],
        });
        const result = await dryRunWorkflow({
          workflow,
          userMessage: '',
          cwd: process.cwd(),
          stubs: {
            ...(failed ? {} : { work: 'done' }),
            cleanup: 'cleaned',
            task: 'done',
            finish: 'done',
            'outer-finish': 'done',
          },
          pauseAtGates: true,
        });
        expect(result.outcome).toBe(failed ? 'failed' : 'paused');
        if (failed) {
          expect(
            result.trace.filter(entry => entry.state === 'failed').map(entry => entry.nodeId)
          ).toEqual(['work', 'group']);
          expect(result.trace.some(entry => entry.state === 'paused')).toBe(false);
          if (topology === 'beside exec')
            expect(result.trace.find(entry => entry.nodeId === 'finish')?.state).toBe('stubbed');
          if (topology === 'before exec')
            expect(result.trace.find(entry => entry.nodeId === 'finish')?.state).toBe('skipped');
          if (outerTopology !== 'sole sink')
            expect(result.trace.find(entry => entry.nodeId === 'outer-finish')?.state).toBe(
              'stubbed'
            );
        } else {
          expect(result.trace.map(entry => entry.nodeId)).toEqual(['work', 'cleanup', 'pause']);
        }
      });
    }
  }
}
