import { describe, test, expect } from 'bun:test';
import { partitionNode } from './base-fields';
import type { WireDagNode } from '../types';

describe('partitionNode', () => {
  test('routes every base field to base and mode fields to variantSpecific', () => {
    const node: WireDagNode = {
      id: 'n',
      // Base fields (one of each, arbitrary but type-valid values).
      depends_on: ['a'],
      when: "$a.output == 'X'",
      trigger_rule: 'all_done',
      model: 'sonnet',
      provider: 'claude',
      context: 'fresh',
      output_format: { type: 'object' },
      allowed_tools: ['Read'],
      denied_tools: ['Bash'],
      idle_timeout: 1000,
      retry: { max_attempts: 2 },
      mcp: './mcp.json',
      skills: ['my-skill'],
      effort: 'high',
      maxBudgetUsd: 1,
      systemPrompt: 'be terse',
      fallbackModel: 'haiku',
      betas: ['beta-1'],
      always_run: true,
      persist_session: true,
      output_type: 'plan',
      // Mode fields.
      script: 'console.log(1)',
      runtime: 'bun',
      deps: ['zod'],
      timeout: 5000,
    };

    const { id, base, variantSpecific } = partitionNode(node);

    expect(id).toBe('n');
    expect(Object.keys(base).sort()).toEqual(
      [
        'allowed_tools',
        'always_run',
        'betas',
        'context',
        'denied_tools',
        'depends_on',
        'effort',
        'fallbackModel',
        'idle_timeout',
        'maxBudgetUsd',
        'mcp',
        'model',
        'output_format',
        'output_type',
        'persist_session',
        'provider',
        'retry',
        'skills',
        'systemPrompt',
        'trigger_rule',
        'when',
      ].sort()
    );
    expect(Object.keys(variantSpecific).sort()).toEqual(['deps', 'runtime', 'script', 'timeout']);
    // Values pass through verbatim.
    expect(base.output_type).toBe('plan');
    expect(base.persist_session).toBe(true);
    expect(variantSpecific.timeout).toBe(5000);
  });

  test('stays sparse: only keys present on the node are copied', () => {
    const { base, variantSpecific } = partitionNode({ id: 'n', prompt: 'hi' });
    expect(base).toEqual({});
    expect(variantSpecific).toEqual({ prompt: 'hi' });
  });

  test('id never leaks into base or variantSpecific', () => {
    const { base, variantSpecific } = partitionNode({ id: 'n', prompt: 'hi', model: 'opus' });
    expect('id' in base).toBe(false);
    expect('id' in variantSpecific).toBe(false);
  });
});
