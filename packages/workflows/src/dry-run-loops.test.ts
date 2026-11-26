import { describe, expect, test } from 'bun:test';
import { makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import { dryRunWorkflow, useDryRunFiles } from './dry-run-test-utils';

const { commandFiles } = useDryRunFiles();

describe('dry-run loops', () => {
  test('attention and fan-out consumers select their local sequence entry', async () => {
    const workflow = makeTestWorkflow({
      name: 'sequence-consumers',
      nodes: [
        {
          id: 'rounds',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              { id: 'children', workflow: 'other', fan_out: { items: '["a", "b"]' } },
              { id: 'answer', wait: { attention: 'Answer' }, depends_on: ['children'] },
              { id: 'finish', prompt: 'Answer: $answer.output.text', depends_on: ['answer'] },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      iterationStubs: {
        children: [
          ['first-a', 'first-b'],
          ['last-a', 'last-b'],
        ],
        answer: [{ text: 'revise' }, { text: 'accept' }],
        finish: ['continue', 'DONE'],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'children').map(entry => entry.output)
    ).toEqual(['["first-a","first-b"]', '["last-a","last-b"]']);
    expect(
      result.trace.filter(entry => entry.nodeId === 'finish').map(entry => entry.resolvedText)
    ).toEqual(['Answer: revise', 'Answer: accept']);
    const invalid = await dryRunWorkflow({
      workflow,
      iterationStubs: { children: [['only-one']] },
    });
    expect(invalid.outcome).toBe('failed');
  });
  test('selects single-node sequence entries by its own iteration and certifies reached entries', async () => {
    const workflow = makeTestWorkflow({
      name: 'sequence-loop',
      nodes: [
        {
          id: 'review',
          loop: { prompt: 'review $LOOP_PREV_OUTPUT', max_iterations: 4, until_field: 'done' },
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' }, note: { type: 'string' } },
            required: ['done', 'note'],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      iterationStubs: {
        review: [
          { done: false, note: 'first' },
          { done: false, note: 'second' },
          { done: true, note: 'accepted' },
          'unreachable-invalid',
        ],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(result.trace[0]?.resolvedText).toBe('review {"done":false,"note":"second"}');
    expect(result.trace[0]?.output).toBe('{"done":true,"note":"accepted"}');
    expect(result.unusedStubs).toEqual([]);
    const failed = await dryRunWorkflow({
      workflow,
      iterationStubs: {
        review: [
          { done: false, note: 'first' },
          { done: true, note: 7 },
        ],
      },
    });
    expect(failed.outcome).toBe('failed');
  });

  test('a skipped body node selects by iteration, not its number of visits', async () => {
    const workflow = makeTestWorkflow({
      name: 'sequence-skips',
      nodes: [
        {
          id: 'rounds',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [
              { id: 'switch', prompt: 'switch' },
              {
                id: 'optional',
                prompt: 'work',
                when: '$switch.output.take == true',
                depends_on: ['switch'],
              },
              {
                id: 'finish',
                prompt: 'finish',
                trigger_rule: 'all_done',
                depends_on: ['optional'],
              },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      iterationStubs: {
        switch: [{ take: true }, { take: false }, { take: true }],
        optional: ['first', 'skipped', 'third'],
        finish: ['continue', 'continue', 'DONE'],
        unused: ['never'],
      },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'optional').map(entry => entry.output)
    ).toEqual(['first', undefined, 'third']);
    expect(result.unusedStubs).toEqual(['unused']);
  });

  test('nested groups restart inner sequences on every outer iteration', async () => {
    const workflow = makeTestWorkflow({
      name: 'nested-sequence',
      nodes: [
        {
          id: 'outer',
          loop_group: {
            until: 'OUTER_DONE',
            max_iterations: 2,
            nodes: [
              {
                id: 'inner',
                loop_group: {
                  until: 'INNER_DONE',
                  max_iterations: 3,
                  nodes: [{ id: 'work', prompt: 'work' }],
                },
              },
              { id: 'finish', prompt: 'finish', depends_on: ['inner'] },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      iterationStubs: { work: ['first', 'INNER_DONE'], finish: ['continue', 'OUTER_DONE'] },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'work').map(entry => entry.output)
    ).toEqual(['first', 'INNER_DONE', 'first', 'INNER_DONE']);
  });

  test('a single-node loop restarts its own sequence within every outer round', async () => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'nested-single-loop',
        nodes: [
          {
            id: 'outer',
            loop_group: {
              until: 'OUTER_DONE',
              max_iterations: 2,
              nodes: [
                { id: 'inner', loop: { prompt: 'review', until: 'INNER_DONE', max_iterations: 2 } },
                { id: 'finish', prompt: 'finish', depends_on: ['inner'] },
              ],
            },
          },
        ],
      }),
      iterationStubs: { inner: ['first', 'INNER_DONE'], finish: ['continue', 'OUTER_DONE'] },
    });
    expect(result.outcome).toBe('completed');
    expect(
      result.trace.filter(entry => entry.nodeId === 'inner').map(entry => entry.output)
    ).toEqual(['INNER_DONE', 'INNER_DONE']);
  });

  test('programmatic declarations reject overlap and empty sequences', async () => {
    const workflow = makeTestWorkflow({
      name: 'ambiguous-stubs',
      nodes: [{ id: 'work', prompt: 'work' }],
    });
    await expect(
      dryRunWorkflow({
        workflow,
        stubs: { work: 'static' },
        iterationStubs: { work: ['sequence'] },
      })
    ).rejects.toThrow('both');
    await expect(dryRunWorkflow({ workflow, iterationStubs: { work: [] } })).rejects.toThrow();
  });
  test('simulates loop completion and max-iteration failure', async () => {
    const completing = makeTestWorkflow({
      name: 'loop-ok',
      nodes: [
        {
          id: 'review',
          loop: { prompt: 'Review $LOOP_PREV_OUTPUT', until: 'DONE', max_iterations: 3 },
        },
      ],
    });
    const completed = await dryRunWorkflow({
      workflow: completing,
      stubs: { review: '<promise>DONE</promise>' },
    });
    expect(completed.trace[0]).toMatchObject({
      state: 'stubbed',
      reason: 'completion signal after 1 iteration(s)',
    });

    const failed = await dryRunWorkflow({
      workflow: completing,
      stubs: { review: 'keep going' },
    });
    expect(failed.outcome).toBe('failed');
    expect(failed.trace[0]?.reason).toContain('exceeded max iterations (3)');
    expect(failed.trace[0]?.reason).toContain("completion signal 'DONE'");
  });

  test.each([
    ['until_bash alone', { until_bash: 'bun run test' }],
    [
      'until_bash with until',
      { until_bash: 'grep -q complete state.json', until: 'ALL_SPRINTS_COMPLETE' },
    ],
  ])('%s assumes completion and names the unevaluated channel', async (_name, channels) => {
    const result = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'loop-deterministic',
        nodes: [{ id: 'fix', loop: { prompt: 'work', max_iterations: 3, ...channels } }],
      }),
      stubs: { fix: 'still working, no sentinel here' },
    });

    expect(result.outcome).not.toBe('failed');
    expect(result.trace[0]).toMatchObject({ state: 'stubbed' });
    expect(result.trace[0]?.reason).toContain('assumed complete after 1 iteration(s)');
    expect(result.trace[0]?.reason).toContain('until_bash');
  });

  test('evaluates until_field exactly rather than guessing (#2563)', async () => {
    const workflow = makeTestWorkflow({
      name: 'judgment-loop',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: { prompt: 'work', max_iterations: 3, until_field: 'done' },
        },
      ],
    });

    const done = await dryRunWorkflow({
      workflow,
      stubs: { triage: { done: true } },
    });
    expect(done.outcome).not.toBe('failed');
    expect(done.trace[0]?.reason).toBe("'done' is true after 1 iteration(s)");

    const notDone = await dryRunWorkflow({
      workflow,
      stubs: { triage: { done: false } },
    });
    expect(notDone.outcome).toBe('failed');
    expect(notDone.trace[0]?.reason).toContain('exceeded max iterations (3)');
    expect(notDone.trace[0]?.reason).toContain("'done' ever being true");
  });

  test('until: plus until_field does not report a failure the real run would not produce', async () => {
    const workflow = makeTestWorkflow({
      name: 'both-channels',
      nodes: [
        {
          id: 'triage',
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          loop: { prompt: 'work', until: 'DONE', max_iterations: 3, until_field: 'done' },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { triage: { done: true } },
    });
    expect(result.outcome).not.toBe('failed');
    expect(result.trace[0]?.reason).toContain("'done' is true");
  });

  test('completes an exhausted loop and loop_group under on_exhausted: complete', async () => {
    const loop = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'loop-exhausted',
        nodes: [
          {
            id: 'review',
            loop: { prompt: 'work', until: 'DONE', max_iterations: 2, on_exhausted: 'complete' },
          },
        ],
      }),
      stubs: { review: 'keep going' },
    });
    expect(loop.outcome).toBe('completed');
    expect(loop.trace[0]).toMatchObject({ state: 'stubbed', output: 'keep going' });
    expect(loop.trace[0]?.reason).toContain('reached max iterations (2)');

    const group = await dryRunWorkflow({
      workflow: makeTestWorkflow({
        name: 'group-exhausted',
        nodes: [
          {
            id: 'group',
            loop_group: {
              until: 'DONE',
              max_iterations: 2,
              on_exhausted: 'complete',
              nodes: [{ id: 'draft', prompt: 'draft' }],
            },
          },
        ],
      }),
      stubs: { draft: 'not yet' },
    });
    expect(group.outcome).toBe('completed');
    expect(group.trace.at(-1)).toMatchObject({
      nodeId: 'group',
      state: 'completed',
      output: 'not yet',
    });
  });

  test('simulates loop-group body outputs without leaking iteration state', async () => {
    const workflow = makeTestWorkflow({
      name: 'loop-group',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              { id: 'draft', prompt: 'draft' },
              { id: 'finish', prompt: 'finish $draft.output', depends_on: ['draft'] },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { draft: 'fresh', finish: 'DONE' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.map(entry => entry.nodeId)).toEqual(['draft', 'finish', 'group']);
    expect(result.trace[1]?.resolvedText).toBe('finish fresh');
  });

  for (const pause of [
    { approval: { message: 'Review the work' } },
    { wait: { attention: 'Review the work' } },
  ]) {
    for (const skipped of [true, false]) {
      const kind = 'approval' in pause ? 'gate' : 'attention wait';
      test.each([
        ['bare', 'DONE', 'DONE'],
        ['tagged', 'Result <promise>DONE</promise>', 'Result'],
      ])(
        `loop-group output reads past a ${skipped ? 'skipped' : 'completed'} ${kind} (%s)`,
        async (_label, rawOutput, expectedOutput) => {
          const workflow = makeTestWorkflow({
            name: 'loop-group-human-sink',
            nodes: [
              {
                id: 'group',
                loop_group: {
                  until: 'DONE',
                  max_iterations: 2,
                  nodes: [
                    { id: 'work', prompt: 'work' },
                    {
                      id: 'end',
                      ...pause,
                      depends_on: ['work'],
                      ...(skipped ? { when: "$work.output == 'never'" } : {}),
                    },
                  ],
                },
              },
              { id: 'after', prompt: 'Result: $group.output', depends_on: ['group'] },
            ],
          });
          const result = await dryRunWorkflow({
            workflow,
            stubs: {
              work: rawOutput,
              after: 'received',
              ...(!skipped && 'wait' in pause ? { end: { text: 'reviewed' } } : {}),
            },
          });

          expect(result.outcome).toBe('completed');
          expect(result.trace.filter(entry => entry.nodeId === 'work')).toHaveLength(1);
          expect(result.trace.find(entry => entry.nodeId === 'end')?.state).toBe(
            skipped ? 'skipped' : 'wait' in pause ? 'stubbed' : 'completed'
          );
          expect(result.trace.find(entry => entry.nodeId === 'group')).toMatchObject({
            state: 'completed',
            output: expectedOutput,
            reason: 'completion signal after 1 iteration(s)',
          });
          expect(result.trace.find(entry => entry.nodeId === 'after')?.resolvedText).toBe(
            `Result: ${expectedOutput}`
          );
        }
      );
    }
  }

  test('resolves $LOOP_PREV in body bindings and conditions as a real run does (#3996)', async () => {
    const cwd = commandFiles({
      report: 'previous PR: [$INPUTS.pr_url]',
    });
    const workflow = makeTestWorkflow({
      name: 'loop-prev',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              {
                id: 'round',
                prompt: 'round',
                output_format: { type: 'object', properties: { pr_url: { type: 'string' } } },
              },
              {
                id: 'report',
                command: 'report',
                depends_on: ['round'],
                with: { pr_url: '$LOOP_PREV.round.output.pr_url' },
              },
              {
                id: 'followup',
                prompt: 'follow up',
                depends_on: ['round'],
                when: "$LOOP_PREV.round.output.pr_url == 'https://example.test/pr/1'",
              },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { round: { pr_url: 'https://example.test/pr/1' }, report: 'more', followup: 'ok' },
    });

    const entries = (nodeId: string) => result.trace.filter(entry => entry.nodeId === nodeId);
    expect(entries('report').map(entry => entry.resolvedText)).toEqual([
      'previous PR: []',
      'previous PR: [https://example.test/pr/1]',
    ]);
    expect(entries('followup').map(entry => [entry.iteration, entry.state])).toEqual([
      [1, 'skipped'],
      [2, 'stubbed'],
    ]);
  });

  test('substitutes loop variables into a body command file as a real run does (#3954)', async () => {
    const cwd = commandFiles({
      report: 'previous: [$LOOP_PREV.round.output.pr_url] feedback: [$LOOP_USER_INPUT]',
    });
    const workflow = makeTestWorkflow({
      name: 'loop-command',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              {
                id: 'round',
                prompt: 'round',
                output_format: { type: 'object', properties: { pr_url: { type: 'string' } } },
              },
              { id: 'report', command: 'report', depends_on: ['round'] },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { round: { pr_url: 'https://example.test/pr/1' }, report: 'more' },
    });

    expect(
      result.trace.filter(entry => entry.nodeId === 'report').map(entry => entry.resolvedText)
    ).toEqual(['previous: [] feedback: []', 'previous: [https://example.test/pr/1] feedback: []']);
  });

  test('gives a command body the output of an include it reads (#3972)', async () => {
    const cwd = commandFiles({
      'check-ci': 'Check CI for [$pr.output]',
      'retry-ci': 'Retry CI for [$pr.output]',
    });
    const block = makeTestWorkflow({
      name: 'open-pr',
      nodes: [{ id: 'open', prompt: 'open the pr' }],
    });
    const parent = makeTestWorkflow({
      name: 'deliver',
      nodes: [
        { id: 'pr', include: 'open-pr' },
        { id: 'check', command: 'check-ci', depends_on: ['pr'] },
        {
          id: 'retry',
          depends_on: ['pr'],
          loop: { command: 'retry-ci', until: 'DONE', max_iterations: 1 },
        },
      ],
    });
    const workflow = makeTestComposedWorkflow([block, parent], 'deliver');
    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { pr__open: 'PR-42', check: 'ok', retry: 'DONE' },
    });

    const resolved = (nodeId: string) =>
      result.trace.find(entry => entry.nodeId === nodeId)?.resolvedText;
    expect(resolved('check')).toBe('Check CI for [PR-42]');
    expect(resolved('retry')).toBe('Retry CI for [PR-42]');
  });

  test('runs a nested body command file through every enclosing loop scope (#3954)', async () => {
    const cwd = commandFiles({
      polish: 'outer: [$LOOP_PREV.a.output] inner: [$LOOP_PREV.polish.output]',
    });
    const workflow = makeTestWorkflow({
      name: 'nested-loop-command',
      nodes: [
        {
          id: 'outer',
          loop_group: {
            until: 'OUTER_DONE',
            max_iterations: 2,
            nodes: [
              { id: 'a', prompt: 'produce a' },
              {
                id: 'inner',
                depends_on: ['a'],
                loop_group: {
                  until: 'DONE',
                  max_iterations: 1,
                  nodes: [{ id: 'polish', command: 'polish' }],
                },
              },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      cwd,
      stubs: { a: 'A-OUT', polish: 'DONE' },
    });

    // Stubs are static, so the inner group ends on its first iteration and its own ref is
    // empty; the outer group never sees OUTER_DONE and runs both iterations.
    expect(
      result.trace.filter(entry => entry.nodeId === 'polish').map(entry => entry.resolvedText)
    ).toEqual(['outer: [] inner: []', 'outer: [A-OUT] inner: []']);
  });
});
