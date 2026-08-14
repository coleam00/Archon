import { describe, test, expect, mock } from 'bun:test';

// This file runs in its own `bun test` invocation (see package.json) mirroring
// manage-run-tool.test.ts's isolation, even though nothing here mock.module's a
// module another test file also mocks — keeping new @archon/core orchestrator
// test files on the same discipline avoids a future collision by omission.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const { buildProposeWorkflowEditsTool, parseAndValidateOps, summarizeProposal } =
  await import('./propose-workflow-edits-tool');

describe('parseAndValidateOps', () => {
  test('parses a valid batch', () => {
    const result = parseAndValidateOps(
      JSON.stringify([
        { op: 'addNode', id: 'gate', variant: 'approval', data: { message: 'ok?' } },
        { op: 'connect', source: 'plan', target: 'gate' },
      ])
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ops).toHaveLength(2);
      expect(result.ops[0]).toEqual({
        op: 'addNode',
        id: 'gate',
        variant: 'approval',
        data: { message: 'ok?' },
      });
    }
  });

  test('rejects invalid JSON', () => {
    const result = parseAndValidateOps('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid JSON');
  });

  test('rejects a non-array payload', () => {
    const result = parseAndValidateOps(JSON.stringify({ op: 'addNode' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be a JSON array');
  });

  test('rejects an empty array', () => {
    const result = parseAndValidateOps('[]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('non-empty');
  });

  test('rejects an unknown op', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'deleteEverything' }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown op');
  });

  test('rejects addNode with an unknown variant', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'addNode', id: 'x', variant: 'notavariant' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown variant');
  });

  test('rejects setField with a path that is not data./base.-prefixed', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'setField', id: 'x', path: 'model', value: 'sonnet' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must start with 'data.' or 'base.'");
  });

  test('rejects rename missing nextId', () => {
    const result = parseAndValidateOps(JSON.stringify([{ op: 'rename', id: 'a' }]));
    expect(result.ok).toBe(false);
  });

  test('error message identifies the offending op index', () => {
    const result = parseAndValidateOps(
      JSON.stringify([{ op: 'remove', id: 'a' }, { op: 'remove' }])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('op[1]');
  });
});

describe('summarizeProposal', () => {
  test('summarizes each op kind in order', () => {
    const summary = summarizeProposal([
      { op: 'addNode', id: 'gate', variant: 'approval' },
      { op: 'connect', source: 'plan', target: 'gate' },
      { op: 'setField', id: 'gate', path: 'data.message', value: 'ok?' },
      { op: 'rename', id: 'gate', nextId: 'review-gate' },
      { op: 'remove', id: 'old-step' },
    ]);
    expect(summary).toContain('Proposed 5 edits');
    expect(summary).toContain("add approval node 'gate'");
    expect(summary).toContain('connect plan → gate');
    expect(summary).toContain('rename gate → review-gate');
    expect(summary).toContain('remove old-step');
  });

  test('singular wording for exactly one edit', () => {
    const summary = summarizeProposal([{ op: 'remove', id: 'x' }]);
    expect(summary).toContain('Proposed 1 edit:');
  });
});

describe('buildProposeWorkflowEditsTool', () => {
  test('has the expected name, flat schema, and required ops field', () => {
    const tool = buildProposeWorkflowEditsTool();
    expect(tool.name).toBe('propose_workflow_edits');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['ops'],
    });
  });

  test('handler returns a summary for a valid batch', async () => {
    const tool = buildProposeWorkflowEditsTool();
    const result = await tool.handler({
      ops: JSON.stringify([{ op: 'remove', id: 'old-step' }]),
    });
    expect(result).toContain('Proposed 1 edit');
    expect(result).toContain('remove old-step');
  });

  test('handler includes the rationale when supplied', async () => {
    const tool = buildProposeWorkflowEditsTool();
    const result = await tool.handler({
      ops: JSON.stringify([{ op: 'remove', id: 'old-step' }]),
      rationale: 'No longer needed after simplifying the pipeline.',
    });
    expect(result).toContain('No longer needed after simplifying the pipeline.');
  });

  test('handler returns an error STRING (never throws) for malformed JSON', async () => {
    const tool = buildProposeWorkflowEditsTool();
    const result = await tool.handler({ ops: '{not valid' });
    expect(result).toContain('Invalid ops:');
  });

  test('handler returns an error string for an unknown op (never throws)', async () => {
    const tool = buildProposeWorkflowEditsTool();
    const result = await tool.handler({ ops: JSON.stringify([{ op: 'nukeIt' }]) });
    expect(result).toContain('Invalid ops:');
    expect(result).toContain('unknown op');
  });

  test('handler rejects a missing ops field without throwing', async () => {
    const tool = buildProposeWorkflowEditsTool();
    const result = await tool.handler({});
    expect(result).toContain('ops is required');
  });

  // Regression: without this guard the tool returned a SUCCESS summary for an id the
  // builder's reducer would then silently rename, so the agent believed the proposal
  // landed as written while the client rejected or mis-applied it.
  describe('node-id pattern', () => {
    test.each([['my gate'], ['2nd-review'], ['check-tests!'], ['-gate'], ['my.gate']])(
      'rejects addNode id %p',
      id => {
        const result = parseAndValidateOps(
          JSON.stringify([{ op: 'addNode', id, variant: 'approval' }])
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('must match');
      }
    );

    test.each([['my_gate'], ['my-gate'], ['_gate']])('accepts addNode id %p', id => {
      const result = parseAndValidateOps(
        JSON.stringify([{ op: 'addNode', id, variant: 'approval' }])
      );
      expect(result.ok).toBe(true);
    });

    test('rejects rename to a pattern-invalid nextId', () => {
      const result = parseAndValidateOps(
        JSON.stringify([{ op: 'rename', id: 'gate', nextId: 'my gate' }])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('must match');
    });

    test('handler surfaces a bad id as an in-turn error, not a success summary', async () => {
      const tool = buildProposeWorkflowEditsTool();
      const result = await tool.handler({
        ops: JSON.stringify([{ op: 'addNode', id: 'my gate', variant: 'approval' }]),
      });
      expect(result).toContain('Invalid ops:');
      expect(result).not.toContain('Proposed 1 edit');
    });
  });

  test('the tool description states the node-id pattern so the agent self-corrects', () => {
    const tool = buildProposeWorkflowEditsTool();
    const ops = (tool.inputSchema.properties as { ops: { description: string } }).ops;
    expect(ops.description).toContain('[a-zA-Z_][a-zA-Z0-9_-]*');
  });
});
