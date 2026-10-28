import { describe, expect, test } from 'bun:test';
import { makeTestComposedWorkflow, makeTestWorkflow } from './test-utils';
import type { ResolvedWorkflow } from './schemas';
import { dryRunWorkflow } from './dry-run-test-utils';

function composedReviewWorkflow(gateNodes: unknown[], includeWhen?: string): ResolvedWorkflow {
  const block = makeTestWorkflow({
    name: 'review-block',
    nodes: [
      { id: 'entry', bash: 'echo entry' },
      {
        id: 'optional',
        bash: 'echo optional',
        depends_on: ['entry'],
        when: "$entry.output == 'never'",
      },
      { id: 'required', bash: 'echo required', depends_on: ['entry'] },
      {
        id: 'synthesize',
        bash: 'echo synthesize',
        depends_on: ['optional', 'required'],
        trigger_rule: 'all_done',
      },
    ],
  });
  const parent = makeTestWorkflow({
    name: 'parent',
    nodes: [
      ...gateNodes,
      {
        id: 'review',
        include: 'review-block',
        depends_on: ['gate'],
        ...(includeWhen !== undefined ? { when: includeWhen } : {}),
      },
      { id: 'consumer', bash: 'echo consumer', depends_on: ['review'] },
    ],
  });
  return makeTestComposedWorkflow([block, parent], 'parent');
}
describe('dry-run reachability and missing stubs', () => {
  test('distinguishes false and malformed when expressions', async () => {
    const workflow = makeTestWorkflow({
      name: 'conditions',
      nodes: [
        { id: 'source', prompt: 'source' },
        { id: 'false', prompt: 'false', depends_on: ['source'], when: "$source.output == 'NO'" },
        { id: 'malformed', prompt: 'bad', depends_on: ['source'], when: '$source ???' },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { source: 'YES' },
    });

    expect(result.trace.map(entry => [entry.nodeId, entry.state, entry.reason])).toEqual([
      ['source', 'stubbed', undefined],
      ['false', 'skipped', 'when_condition_false'],
      ['malformed', 'skipped', 'when_condition_parse_error'],
    ]);
    expect(result.missingStubs).toEqual([]);
  });

  test('nonnumeric conditions allow OR fallback and record ordinary false skips', async () => {
    const workflow = makeTestWorkflow({
      name: 'numeric-fallback',
      nodes: [
        { id: 'a', prompt: 'score' },
        { id: 'b', prompt: 'status' },
        {
          id: 'fallback',
          prompt: 'fallback',
          depends_on: ['a', 'b'],
          when: "$a.output > 50 || $b.output == 'ok'",
        },
        {
          id: 'both',
          prompt: 'both',
          depends_on: ['a', 'b'],
          when: "$a.output > 50 && $b.output == 'ok'",
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { a: 'N/A', b: 'ok', fallback: 'ran' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'fallback')).toMatchObject({
      state: 'stubbed',
      output: 'ran',
    });
    expect(result.trace.find(entry => entry.nodeId === 'both')).toMatchObject({
      state: 'skipped',
      reason: 'when_condition_false',
      cause: { kind: 'condition', expr: "$a.output > 50 && $b.output == 'ok'" },
    });
    expect(result.missingStubs).toEqual([]);
  });

  test('fails an object-valued condition field instead of recording a false skip', async () => {
    const workflow = makeTestWorkflow({
      name: 'structured-condition',
      nodes: [
        { id: 'source', prompt: 'source' },
        {
          id: 'gated',
          prompt: 'gated',
          depends_on: ['source'],
          when: "$source.output.route == 'true'",
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { source: { route: { ready: true } }, gated: 'unused' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.trace.find(entry => entry.nodeId === 'gated')).toMatchObject({
      state: 'failed',
      reason: expect.stringContaining(
        "Condition reference '$source.output.route' resolved to an object"
      ),
    });
  });

  test.each([
    ['object', { ready: true }],
    ['array', ['a', 'b']],
  ])(
    'fails an %s-valued condition input instead of recording a false skip (#2999)',
    async (kind, value) => {
      const result = await dryRunWorkflow({
        workflow: makeTestWorkflow({
          name: 'structured-input-condition',
          inputs: { route: { default: value } },
          nodes: [{ id: 'gated', prompt: 'gated', when: "$INPUTS.route == 'true'" }],
        }),
        stubs: { gated: 'unused' },
      });

      expect(result.outcome).toBe('failed');
      expect(result.trace.find(entry => entry.nodeId === 'gated')).toMatchObject({
        state: 'failed',
        reason: expect.stringContaining(
          `Condition reference '$INPUTS.route' resolved to an ${kind}`
        ),
      });
    }
  );

  test('applies all trigger rules after failed and skipped upstream nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'triggers',
      nodes: [
        { id: 'ok', prompt: 'ok' },
        { id: 'skip', prompt: 'skip', when: "$ok.output == 'never'" },
        { id: 'fail', prompt: 'missing' },
        { id: 'all_success', prompt: 'a', depends_on: ['ok', 'skip'] },
        { id: 'one_success', prompt: 'b', depends_on: ['ok', 'fail'], trigger_rule: 'one_success' },
        {
          id: 'none_failed',
          prompt: 'c',
          depends_on: ['ok', 'skip'],
          trigger_rule: 'none_failed_min_one_success',
        },
        { id: 'all_done', prompt: 'd', depends_on: ['skip', 'fail'], trigger_rule: 'all_done' },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { ok: 'yes', one_success: 'one', none_failed: 'none', all_done: 'done' },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states.all_success).toBe('skipped');
    expect(states.one_success).toBe('stubbed');
    expect(states.none_failed).toBe('stubbed');
    expect(states.all_done).toBe('stubbed');
  });

  test('skips every composed node when the include condition is false', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow(
        [{ id: 'gate', bash: 'echo gate' }],
        "$gate.output == 'run'"
      ),
      stubs: {
        gate: 'skip',
        review__synthesize: 'must not run',
        consumer: 'must not run',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states).toEqual({
      gate: 'stubbed',
      review__entry: 'skipped',
      review__optional: 'skipped',
      review__required: 'skipped',
      review__synthesize: 'skipped',
      consumer: 'skipped',
    });
  });

  test('skips every composed node when the include dependencies are ineligible', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow([
        { id: 'source', bash: 'echo source' },
        {
          id: 'gate',
          bash: 'echo gate',
          depends_on: ['source'],
          when: "$source.output == 'never'",
        },
      ]),
      stubs: {
        source: 'ready',
        review__synthesize: 'must not run',
        consumer: 'must not run',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states).toEqual({
      source: 'stubbed',
      gate: 'skipped',
      review__entry: 'skipped',
      review__optional: 'skipped',
      review__required: 'skipped',
      review__synthesize: 'skipped',
      consumer: 'skipped',
    });
  });

  test('keeps all_done active for intentionally skipped branches inside a running block', async () => {
    const result = await dryRunWorkflow({
      workflow: composedReviewWorkflow(
        [{ id: 'gate', bash: 'echo gate' }],
        "$gate.output == 'run'"
      ),
      stubs: {
        gate: 'run',
        review__entry: 'started',
        review__required: 'report',
        review__synthesize: 'ready',
        consumer: 'done',
      },
    });
    const states = Object.fromEntries(result.trace.map(entry => [entry.nodeId, entry.state]));

    expect(states.review__optional).toBe('skipped');
    expect(states.review__synthesize).toBe('stubbed');
    expect(states.consumer).toBe('stubbed');
  });
  test('requires stubs only for reachable AI and default code nodes', async () => {
    const workflow = makeTestWorkflow({
      name: 'reachable',
      nodes: [
        { id: 'gate', prompt: 'gate' },
        { id: 'unreachable', prompt: 'no', depends_on: ['gate'], when: "$gate.output == 'NO'" },
        { id: 'code', bash: 'printf hello', depends_on: ['gate'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { gate: 'YES' },
    });

    expect(result.missingStubs).toEqual(['code']);
    expect(result.trace.find(entry => entry.nodeId === 'unreachable')?.state).toBe('skipped');
  });

  test('tolerates a missing stub on an all_done join and completes past it (#2869)', async () => {
    const workflow = makeTestWorkflow({
      name: 'join-tolerance',
      nodes: [
        { id: 'lens', prompt: 'lens' },
        {
          id: 'review-complete',
          bash: 'true',
          depends_on: ['lens'],
          trigger_rule: 'all_done',
        },
        { id: 'synthesize', prompt: 'synthesize', depends_on: ['review-complete'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { lens: 'ok', synthesize: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.missingStubs).toEqual(['review-complete']);
    expect(result.trace.find(entry => entry.nodeId === 'review-complete')).toMatchObject({
      state: 'stubbed',
      reason: expect.stringContaining('all_done'),
    });
    expect(result.trace.find(entry => entry.nodeId === 'synthesize')?.state).toBe('stubbed');
  });

  test('still fails the run when a plain (non-all_done) node is missing its stub', async () => {
    const workflow = makeTestWorkflow({
      name: 'no-tolerance',
      nodes: [
        { id: 'lens', prompt: 'lens' },
        { id: 'gate', bash: 'true', depends_on: ['lens'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { lens: 'ok' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.missingStubs).toEqual(['gate']);
  });

  test('tolerates a missing stub on an all_done node nested in a loop_group body (#2869)', async () => {
    const workflow = makeTestWorkflow({
      name: 'loop-group-join-tolerance',
      nodes: [
        {
          id: 'group',
          loop_group: {
            until_bash: 'true',
            max_iterations: 1,
            nodes: [
              { id: 'lens', prompt: 'lens' },
              {
                id: 'review-complete',
                bash: 'true',
                depends_on: ['lens'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { lens: 'ok' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'group')?.state).toBe('completed');
    expect(result.trace.find(entry => entry.nodeId === 'review-complete')?.state).toBe('stubbed');
    expect(result.missingStubs).toEqual(['review-complete']);
  });

  test('tolerates a missing stub on a bare all_done loop node, on every channel (#2966)', async () => {
    const workflow = makeTestWorkflow({
      name: 'loop-join-tolerance',
      nodes: [
        { id: 'lens', prompt: 'lens' },
        {
          id: 'signal',
          loop: { prompt: 'refine $LOOP_PREV_OUTPUT', until: 'DONE', max_iterations: 3 },
          depends_on: ['lens'],
          trigger_rule: 'all_done',
        },
        {
          id: 'field',
          loop: { prompt: 'refine', until_field: 'done', max_iterations: 3 },
          output_format: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
          },
          depends_on: ['signal'],
          trigger_rule: 'all_done',
        },
        {
          id: 'checked',
          loop: { prompt: 'refine', until_bash: 'bun run test', max_iterations: 3 },
          depends_on: ['field'],
          trigger_rule: 'all_done',
        },
        { id: 'synthesize', prompt: 'synthesize', depends_on: ['checked'] },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { lens: 'ok', synthesize: 'done' },
    });

    expect(result.outcome).toBe('completed');
    expect(result.missingStubs).toEqual(['checked', 'field', 'signal']);
    expect(result.toleratedMissingStubs).toEqual(['checked', 'field', 'signal']);
    for (const nodeId of ['signal', 'field', 'checked']) {
      const entry = result.trace.find(traced => traced.nodeId === nodeId);
      expect(entry?.state).toBe('stubbed');
      expect(entry?.reason).toContain('all_done');
      expect(entry?.reason).toContain('after 1 iteration(s)');
    }
    expect(result.trace.find(entry => entry.nodeId === 'signal')?.reason).toContain(
      'completion signal'
    );
    expect(result.trace.find(entry => entry.nodeId === 'field')?.reason).toContain(
      "'done' is true"
    );
    expect(result.trace.find(entry => entry.nodeId === 'checked')?.reason).toContain(
      'assumed complete'
    );
    expect(result.trace.find(entry => entry.nodeId === 'synthesize')?.state).toBe('stubbed');
  });

  test('still fails the run when a plain (non-all_done) loop node is missing its stub', async () => {
    const workflow = makeTestWorkflow({
      name: 'loop-no-tolerance',
      nodes: [
        { id: 'lens', prompt: 'lens' },
        {
          id: 'refine',
          loop: { prompt: 'refine', until: 'DONE', max_iterations: 3 },
          depends_on: ['lens'],
        },
      ],
    });
    const result = await dryRunWorkflow({
      workflow,
      stubs: { lens: 'ok' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.missingStubs).toEqual(['refine']);
    expect(result.toleratedMissingStubs).toEqual([]);
  });
});
describe('all_done tolerance vs a placeholder that cannot be generated (#2869)', () => {
  test('does not call a gap tolerated when generating its placeholder is what failed', async () => {
    const workflow = makeTestWorkflow({
      name: 'ungeneratable-join',
      nodes: [
        { id: 'a', prompt: 'a' },
        {
          id: 'join',
          prompt: 'join',
          depends_on: ['a'],
          trigger_rule: 'all_done',
          output_format: {
            $async: true,
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { a: 'stub' },
    });

    expect(result.outcome).toBe('failed');
    expect(result.trace.find(entry => entry.nodeId === 'join')?.state).toBe('failed');
    expect(result.missingStubs).toEqual(['join']);
    expect(result.toleratedMissingStubs).toEqual([]);
  });

  test('does not call a loop gap tolerated when the placeholder ends no iteration (#2966)', async () => {
    const workflow = makeTestWorkflow({
      name: 'unendable-loop-join',
      nodes: [
        { id: 'a', prompt: 'a' },
        {
          id: 'refine',
          loop: { prompt: 'refine', until: 'DONE', max_iterations: 3 },
          output_format: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
          depends_on: ['a'],
          trigger_rule: 'all_done',
        },
      ],
    });

    const result = await dryRunWorkflow({
      workflow,
      stubs: { a: 'stub' },
    });

    expect(result.outcome).toBe('failed');
    const failure = result.trace.find(entry => entry.nodeId === 'refine');
    expect(failure?.state).toBe('failed');
    expect(failure?.reason).toContain(
      "cannot tolerate it: a generated placeholder would run to max_iterations without completion signal 'DONE'"
    );
    expect(result.missingStubs).toEqual(['refine']);
    expect(result.toleratedMissingStubs).toEqual([]);
  });
});
test('dry-run nested conditions enforce the same declared contract as live outputs', async () => {
  const workflow = (field: string) =>
    makeTestWorkflow({
      name: 'nested-stub',
      nodes: [
        {
          id: 'review',
          bash: 'echo json',
          output_format: {
            type: 'object',
            properties: {
              proposal: { type: 'object', properties: { action: { type: 'string' } } },
            },
          },
        },
        {
          id: 'read',
          bash: 'echo read',
          depends_on: ['review'],
          when: `$review.output.proposal.${field} == 'add'`,
        },
      ],
    });
  const run = (field: string) =>
    dryRunWorkflow({
      workflow: workflow(field),
      stubs: { review: { proposal: { action: 'add' } }, read: 'read' },
    });
  const valid = await run('action');
  expect(valid.outcome).toBe('completed');
  expect(valid.trace.find(node => node.nodeId === 'read')?.state).toBe('stubbed');
  const typo = await run('typo');
  expect(typo.outcome).toBe('failed');
  expect(typo.trace.find(node => node.nodeId === 'read')?.reason).toContain("field 'typo'");
});
