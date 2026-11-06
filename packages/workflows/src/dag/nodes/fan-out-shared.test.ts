import { describe, expect, it } from 'bun:test';
import { composeFanOutNodeSchema, workflowNodeSchema } from '../../schemas';
import { fanOutOutcome } from '../../schemas/fan-out-outcome';
import { buildInstanceSnapshots } from '../../fan-out-identity';
import { OutputRefError } from '../../output-ref';
import type { ChildWorkflowOutcome } from '../child-run';
import type { ShellInputContext } from '../references';
import { joinComposeOutcomes } from './compose-fan-out/compose-fan-out-join';
import { joinFanOutOutcomes, type FanOutJoinResult } from './workflow/fan-out-join';
import { resolveFanOutItems, resolveFanOutStaticInputs } from './fan-out-shared';

function context(): ShellInputContext {
  return {
    workflowRun: {
      id: 'parent',
      user_message: 'request',
      metadata: { inputs_values: { flag: true, bag: { count: 2 } } },
    },
    artifactsDir: '/artifacts',
    stateDir: '/state',
    baseBranch: 'dev',
    docsDir: '/docs',
    nodeOutputs: new Map([
      ['list', { state: 'completed', output: '[1,{"v":true}]' }],
      [
        'data',
        { state: 'completed', output: '{"value":[1,2]}', structuredOutput: { value: [1, 2] } },
      ],
    ]),
    loopBodyScopes: [],
  };
}

const workflowNode = workflowNodeSchema.parse({ id: 'fan', kind: 'workflow', workflow: 'child' });
const composeNode = composeFanOutNodeSchema.parse({
  id: 'fan',
  kind: 'compose_fan_out',
  include: 'block',
  fan_out: { items: '$list.output', as: 'item' },
});

for (const node of [workflowNode, composeNode]) {
  describe(`${node.kind} shared resolution`, () => {
    it('resolves array output and empty arrays', () => {
      expect(resolveFanOutItems(node, context(), { items: '$list.output' })).toEqual({
        items: [1, { v: true }],
      });
      expect(resolveFanOutItems(node, context(), { items: '[]' })).toEqual({ items: [] });
    });

    it('keeps the malformed JSON error', () => {
      let parseError = '';
      try {
        JSON.parse('broken');
      } catch (err) {
        parseError = (err as Error).message;
      }
      expect(resolveFanOutItems(node, context(), { items: 'broken' })).toEqual({
        error: `fan_out.items on 'fan' could not be resolved to a JSON array: ${parseError}`,
      });
    });

    it('keeps the non-array error including the source expression', () => {
      expect(resolveFanOutItems(node, context(), { items: '$data.output' })).toEqual({
        error:
          "fan_out.items on 'fan' resolved to object, not a JSON array. '$data.output' must reference a node output that produces a JSON array.",
      });
    });

    it('keeps field-reference errors instead of silently producing no items', () => {
      const detail = new OutputRefError('missing', 'items', 'unknown-node', {
        reference: '$missing.output.items',
        candidates: [],
      }).message;
      expect(resolveFanOutItems(node, context(), { items: '$missing.output.items' })).toEqual({
        error: `fan_out.items on 'fan' could not be resolved to a JSON array: ${detail}`,
      });
    });

    it('resolves typed literals, whole references, inputs and text templates', () => {
      expect(resolveFanOutStaticInputs(node, context())).toEqual({ inputs: {} });
      expect(
        resolveFanOutStaticInputs(
          {
            ...node,
            with: {
              flag: false,
              count: 3,
              nil: null,
              array: [1],
              object: { x: true },
              whole: '$data.output',
              input: '$INPUTS.bag',
              bool: '$INPUTS.flag',
              text: 'branch=$BASE_BRANCH; flag=$INPUTS.flag; list=$list.output',
            },
          },
          context()
        )
      ).toEqual({
        inputs: {
          flag: false,
          count: 3,
          nil: null,
          array: [1],
          object: { x: true },
          whole: { value: [1, 2] },
          input: { count: 2 },
          bool: true,
          text: 'branch=dev; flag=true; list=[1,{"v":true}]',
        },
      });
    });

    it('keeps unknown whole output references lenient and field references strict', () => {
      expect(
        resolveFanOutStaticInputs({ ...node, with: { value: '$missing.output' } }, context())
      ).toEqual({ inputs: { value: '' } });
      const detail = new OutputRefError('missing', 'value', 'unknown-node', {
        reference: '$missing.output.value',
        candidates: [],
      }).message;
      expect(
        resolveFanOutStaticInputs({ ...node, with: { value: '$missing.output.value' } }, context())
      ).toEqual({
        error: `fan_out 'with:' on 'fan' could not be resolved: ${detail}`,
      });
    });
  });
}

for (const error of ['supplied error', undefined, '']) {
  for (const kind of ['workflow', 'compose'] as const) {
    it(`${kind} join preserves ordered values and failure markers with error ${JSON.stringify(error)}`, () => {
      const outcomes = [
        {
          status: 'completed',
          childRunId: 'ok',
          output: '{"value":1}',
          structuredOutput: { value: 1 },
        },
        { status: 'failed', childRunId: 'bad', error },
        { status: 'cancelled', childRunId: 'cancelled', error },
        { status: 'completed', childRunId: 'text', output: 'plain text' },
      ] satisfies ChildWorkflowOutcome[];
      const slots = fanOutOutcome([
        { index: 0, outcome: 'completed', child_run_id: 'ok' },
        { index: 1, outcome: 'failed', child_run_id: 'bad', error: 'failed' },
        { index: 2, outcome: 'cancelled_unattributed', child_run_id: 'cancelled' },
        { index: 3, outcome: 'completed', child_run_id: 'text' },
      ]).slots;
      const expected = (noun: string): Extract<FanOutJoinResult, { status: 'completed' }> => ({
        status: 'completed',
        elements: [
          { value: 1 },
          { archon_failed: true, error: error ?? `${noun} failed`, status: 'failed' },
          { archon_failed: true, error: error ?? `${noun} cancelled`, status: 'cancelled' },
          'plain text',
        ],
      });
      const actual =
        kind === 'workflow'
          ? joinFanOutOutcomes('parent', workflowNode, 'all_done', outcomes, slots)
          : joinComposeOutcomes(
              composeNode,
              'all_done',
              buildInstanceSnapshots([0, 1, 2, 3]),
              outcomes.map(o => ({ ...o, output: o.output ?? '' })),
              () => undefined
            );
      expect(actual).toEqual(expected(kind === 'workflow' ? 'child' : 'instance'));
    });
  }
}
