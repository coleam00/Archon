import { describe, it, expect } from 'bun:test';
import { toWorkflowDefinition } from '../../exporter/toWorkflowDefinition';
import { fromWorkflowDefinition } from '../../exporter/fromWorkflowDefinition';

describe('toWorkflowDefinition', () => {
  it('round-trips a minimal command workflow byte-equivalent', () => {
    const input = {
      name: 'w',
      description: 'd',
      nodes: [{ id: 'a', command: 'classify' }],
    };
    const out = toWorkflowDefinition(fromWorkflowDefinition(input));
    expect(out).toEqual(input);
  });

  it('preserves unknown workflow + node keys on round-trip', () => {
    const input = {
      name: 'w',
      description: 'd',
      future_workflow_knob: 'experimental',
      nodes: [{ id: 'a', command: 'classify', __experimental_node_flag: true }],
    };
    const out = toWorkflowDefinition(fromWorkflowDefinition(input));
    expect(out).toEqual(input);
  });

  it('preserves trigger_rule, depends_on, when, idle_timeout', () => {
    const input = {
      name: 'w',
      description: 'd',
      nodes: [
        { id: 'a', command: 'classify' },
        {
          id: 'b',
          command: 'act',
          depends_on: ['a'],
          when: "$a.output == 'ok'",
          trigger_rule: 'all_success',
          idle_timeout: 1000,
        },
      ],
    };
    const out = toWorkflowDefinition(fromWorkflowDefinition(input));
    expect(out).toEqual(input);
  });
});
