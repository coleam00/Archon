import { describe, expect, it } from 'bun:test';
import { dagNodeSchema } from '../../../schemas';
import { resolveNodeOutputField } from '../../../output-ref';
import type { NodeOutput } from '../../../schemas';
import { ExecOutputContractError, certifyExecOutput } from './exec-output';

describe('exec composition-only output certification', () => {
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    it(`retains optional nested ${keyword} declarations through certification`, () => {
      const node = dagNodeSchema.parse({
        id: 'producer',
        bash: "echo '{}'",
        output_format: {
          [keyword]: [{ properties: { proposal: { properties: { action: { type: 'string' } } } } }],
        },
      });
      if (node.kind !== 'exec') throw new Error('Expected a bash node');
      const certified = certifyExecOutput(node, '{}', []);
      expect(certified.declaredOutputPaths).toEqual([['proposal'], ['proposal', 'action']]);
      const output: NodeOutput = { state: 'completed', ...certified };
      expect(
        resolveNodeOutputField(
          output,
          node.id,
          'proposal.action',
          '$producer.output.proposal.action'
        )
      ).toEqual({ kind: 'empty' });
      expect(() =>
        resolveNodeOutputField(output, node.id, 'proposal.typo', '$producer.output.proposal.typo')
      ).toThrow('not declared');
    });
  }
});

describe('exec metric record certification', () => {
  it('fails a script whose stdout carries a malformed metric record', () => {
    const node = dagNodeSchema.parse({
      id: 'count',
      script: 'emit',
      runtime: 'bun',
      output_format: { type: 'object', properties: { metrics: { type: 'array' } } },
    });
    if (node.kind !== 'exec') throw new Error('Expected a script node');
    const stdout = JSON.stringify({
      metrics: [
        { name: 'factory.prs_merged', kind: 'count', unit: 'prs', value: -1, subject: null },
      ],
    });
    expect(() => certifyExecOutput(node, stdout, [])).toThrow(ExecOutputContractError);
    expect(() => certifyExecOutput(node, stdout, [])).toThrow('/metrics/0/value');
  });
});
