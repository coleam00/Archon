// @archon-test-isolated
import { describe, it, expect } from 'bun:test';
import type { NodeOutput, DagNode } from '../schemas';
import { makeOutput, node } from './test-utils';
import { checkTriggerRule } from './trigger-rule';

describe('checkTriggerRule', () => {
  it('returns eligibility and skip provenance for every rule', () => {
    const completed = makeOutput('completed');
    const failed = makeOutput('failed');
    const conditionSkipped: NodeOutput = {
      state: 'skipped',
      output: '',
      cause: { kind: 'condition', expr: '$route.output == review' },
    };
    const failureSkipped: NodeOutput = {
      state: 'skipped',
      output: '',
      cause: { kind: 'upstream_failed', origin: 'validate' },
    };

    const cases: Array<{
      current: DagNode;
      outputs: Map<string, NodeOutput>;
      expected: ReturnType<typeof checkTriggerRule>;
    }> = [
      {
        current: node('join', ['left', 'right']),
        outputs: new Map([
          ['left', completed],
          ['right', failed],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'right' } },
      },
      {
        current: node('join', ['left', 'right']),
        outputs: new Map([
          ['left', completed],
          ['right', conditionSkipped],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_skipped', origin: 'right' } },
      },
      {
        current: node('join', ['left', 'right']),
        outputs: new Map([
          ['left', completed],
          ['right', failureSkipped],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'validate' } },
      },
      {
        current: node('join', ['left', 'right'], { trigger_rule: 'one_success' }),
        outputs: new Map([
          ['left', conditionSkipped],
          ['right', failureSkipped],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'validate' } },
      },
      {
        current: node('join', ['left', 'right'], { trigger_rule: 'one_success' }),
        outputs: new Map([
          ['left', conditionSkipped],
          ['right', conditionSkipped],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_skipped', origin: 'left' } },
      },
      {
        current: node('join', ['left', 'right'], {
          trigger_rule: 'none_failed_min_one_success',
        }),
        outputs: new Map([
          ['left', completed],
          ['right', failed],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'right' } },
      },
      {
        current: node('join', ['left', 'right'], {
          trigger_rule: 'none_failed_min_one_success',
        }),
        outputs: new Map([
          ['left', completed],
          ['right', failureSkipped],
        ]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'validate' } },
      },
      {
        current: node('join', ['left', 'right'], {
          trigger_rule: 'none_failed_min_one_success',
        }),
        outputs: new Map([
          ['left', completed],
          ['right', conditionSkipped],
        ]),
        expected: { decision: 'run' },
      },
      {
        current: node('join', ['left', 'right'], { trigger_rule: 'all_done' }),
        outputs: new Map([
          ['left', failed],
          ['right', conditionSkipped],
        ]),
        expected: { decision: 'run' },
      },
      {
        current: node('join', ['left', 'right']),
        outputs: new Map([['left', completed]]),
        expected: { decision: 'skip', cause: { kind: 'upstream_failed', origin: 'right' } },
      },
    ];

    for (const { current, outputs, expected } of cases) {
      expect(checkTriggerRule(current, outputs)).toEqual(expected);
    }
  });

  it('propagates the root failure through a chain of skipped nodes', () => {
    const outputs = new Map<string, NodeOutput>([['validate', makeOutput('failed')]]);
    const packageDecision = checkTriggerRule(node('package', ['validate']), outputs);
    expect(packageDecision).toEqual({
      decision: 'skip',
      cause: { kind: 'upstream_failed', origin: 'validate' },
    });
    if (packageDecision.decision !== 'skip') throw new Error('package should skip');
    outputs.set('package', { state: 'skipped', output: '', cause: packageDecision.cause });

    expect(checkTriggerRule(node('publish', ['package']), outputs)).toEqual({
      decision: 'skip',
      cause: { kind: 'upstream_failed', origin: 'validate' },
    });
  });

  it('all_success: runs when all deps completed', () => {
    const n = node('b', ['a']);
    const outputs = new Map([['a', makeOutput('completed')]]);
    expect(checkTriggerRule(n, outputs)).toEqual({ decision: 'run' });
  });

  it('one_success: runs when at least one dep completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('completed')],
      ['b', makeOutput('failed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toEqual({ decision: 'run' });
  });

  it('one_success: skips when no deps completed', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'one_success' });
    const outputs = new Map([
      ['a', makeOutput('failed')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toEqual({
      decision: 'skip',
      cause: { kind: 'upstream_failed', origin: 'a' },
    });
  });

  it('all_done: skips when a dep is still running', () => {
    const n = node('c', ['a', 'b'], { trigger_rule: 'all_done' });
    const outputs = new Map([
      ['a', makeOutput('running')],
      ['b', makeOutput('completed')],
    ]);
    expect(checkTriggerRule(n, outputs)).toEqual({
      decision: 'skip',
      cause: { kind: 'upstream_skipped', origin: 'a' },
    });
  });

  it('no deps: always runs', () => {
    const n = node('a');
    const outputs = new Map<string, NodeOutput>();
    expect(checkTriggerRule(n, outputs)).toEqual({ decision: 'run' });
  });

  it('all_done: runs when absent upstream is synthesised as failed (failed is terminal)', () => {
    const n = node('c', ['a'], { trigger_rule: 'all_done' });
    const outputs = new Map<string, NodeOutput>(); // 'a' absent -> synthesised as failed -> terminal
    expect(checkTriggerRule(n, outputs)).toEqual({ decision: 'run' });
  });
});

describe('checkTriggerRule -- missing upstream treated as failed', () => {
  it('none_failed_min_one_success: skips when all deps skipped (no success)', () => {
    const n = node('implement', ['a', 'b'], { trigger_rule: 'none_failed_min_one_success' });
    const outputs = new Map([
      ['a', makeOutput('skipped')],
      ['b', makeOutput('skipped')],
    ]);
    expect(checkTriggerRule(n, outputs)).toEqual({
      decision: 'skip',
      cause: { kind: 'upstream_skipped', origin: 'a' },
    });
  });
});
