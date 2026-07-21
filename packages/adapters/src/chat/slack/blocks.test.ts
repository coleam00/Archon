import {
  buildApprovalBlocks,
  buildApprovalResolutionBlocks,
  buildStatusBlocks,
  formatCostFooter,
  REACTION_FAILURE,
  REACTION_RUNNING,
  REACTION_SUCCESS,
  type RunSnapshot,
} from './blocks';

describe('formatCostFooter', () => {
  test('returns null when neither cost nor tokens are present', () => {
    expect(formatCostFooter({})).toBeNull();
  });

  test('returns null when cost is undefined and tokens are zero', () => {
    expect(formatCostFooter({ tokens: { input: 0, output: 0 } })).toBeNull();
  });

  test('formats cost only', () => {
    expect(formatCostFooter({ cost: 0.0234 })).toBe('_cost: $0.0234_');
  });

  test('formats tokens from input+output sum', () => {
    expect(formatCostFooter({ tokens: { input: 1500, output: 500 } })).toBe('_2.0k tokens_');
  });

  test('formats tokens using explicit total when provided', () => {
    expect(formatCostFooter({ tokens: { input: 0, output: 0, total: 12345 } })).toBe(
      '_12.3k tokens_'
    );
  });

  test('formats millions with M suffix', () => {
    expect(formatCostFooter({ tokens: { input: 1_200_000, output: 800_000 } })).toBe(
      '_2.0M tokens_'
    );
  });

  test('combines cost, tokens, and stopReason', () => {
    expect(
      formatCostFooter({
        cost: 0.1234,
        tokens: { input: 5000, output: 7500 },
        stopReason: 'end_turn',
      })
    ).toBe('_cost: $0.1234 · 12.5k tokens · stop: end_turn_');
  });

  test('drops non-finite cost', () => {
    expect(formatCostFooter({ cost: Number.NaN })).toBeNull();
    expect(formatCostFooter({ cost: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('buildApprovalBlocks', () => {
  test('produces section + actions block with both buttons', () => {
    const { blocks, fallbackText } = buildApprovalBlocks({
      runId: 'a1b2c3d4-deadbeef',
      nodeId: 'review-step',
      message: 'Approve the migration?',
    });

    expect(fallbackText).toBe('Approval needed for run a1b2c3d4');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'section',
      text: { type: 'mrkdwn' },
    });
    const sectionText = (blocks[0] as { text: { text: string } }).text.text;
    expect(sectionText).toContain('Approval needed');
    expect(sectionText).toContain('Approve the migration?');
    expect(sectionText).toContain('a1b2c3d4');

    const actions = blocks[1] as {
      type: string;
      block_id?: string;
      elements: Array<{ type: string; action_id: string; style?: string }>;
    };
    expect(actions.type).toBe('actions');
    expect(actions.block_id).toBe('approval:a1b2c3d4-deadbeef:review-step');
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[0]?.action_id).toBe('approve:a1b2c3d4-deadbeef:review-step');
    expect(actions.elements[0]?.style).toBe('primary');
    expect(actions.elements[1]?.action_id).toBe('reject:a1b2c3d4-deadbeef:review-step');
    expect(actions.elements[1]?.style).toBe('danger');
  });
});

describe('buildApprovalResolutionBlocks', () => {
  test('approved variant includes actor and original message, no buttons', () => {
    const { blocks } = buildApprovalResolutionBlocks({
      runId: 'a1b2c3d4-x',
      nodeId: 'review',
      decision: 'approved',
      actorUserId: 'U123ALICE',
      originalMessage: 'Approve the migration?',
      outcomeNote: 'workflow resumed',
    });

    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain('Approved');
    expect(text).toContain('<@U123ALICE>');
    expect(text).toContain('Approve the migration?');
    expect(text).toContain('workflow resumed');
  });

  test('rejected variant uses red x and Rejected label', () => {
    const { blocks } = buildApprovalResolutionBlocks({
      runId: 'a1b2c3d4-x',
      nodeId: 'review',
      decision: 'rejected',
      actorUserId: 'U123BOB',
      originalMessage: 'Approve?',
    });
    const text = (blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain('Rejected');
    expect(text).toContain(':x:');
  });
});

describe('buildStatusBlocks', () => {
  const startedAt = 1_000_000;

  function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
    return {
      runId: 'a1b2c3d4-zzzz',
      workflowName: 'assist',
      startedAt,
      nodes: [],
      ...overrides,
    };
  }

  test('running snapshot includes Cancel button and elapsed time', () => {
    const { blocks } = buildStatusBlocks(snapshot(), startedAt + 12_345);
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('Workflow running');
    expect(header).toContain('`assist`');
    expect(header).toContain('`a1b2c3d4`');
    expect(header).toContain('12s');

    const last = blocks[blocks.length - 1] as {
      type: string;
      block_id?: string;
      elements?: Array<{ action_id: string }>;
    };
    expect(last.type).toBe('actions');
    expect(last.block_id).toBe('run-controls:a1b2c3d4-zzzz');
    expect(last.elements?.[0]?.action_id).toBe('cancel:a1b2c3d4-zzzz');
  });

  test('renders node list with state glyphs', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        nodes: [
          { nodeId: 'a', nodeName: 'plan', state: 'completed', durationMs: 4000 },
          { nodeId: 'b', nodeName: 'review', state: 'running' },
          { nodeId: 'c', nodeName: 'apply', state: 'pending' },
          { nodeId: 'd', nodeName: 'verify', state: 'failed', error: 'boom' },
          { nodeId: 'e', nodeName: 'cleanup', state: 'skipped' },
        ],
      }),
      startedAt + 5000
    );
    const nodeBlock = blocks[1] as { text: { text: string } };
    const text = nodeBlock.text.text;
    expect(text).toContain(':white_check_mark: `plan`');
    expect(text).toContain('4s');
    expect(text).toContain(':hourglass_flowing_sand: `review`');
    expect(text).toContain(':white_circle: `apply`');
    expect(text).toContain(':x: `verify`');
    expect(text).toContain('boom');
    expect(text).toContain(':fast_forward: `cleanup`');
  });

  test('terminal completed snapshot drops Cancel button and shows total cost', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        terminal: 'completed',
        totalCostUsd: 0.123,
      }),
      startedAt + 1000
    );
    expect(blocks.find(b => (b as { type: string }).type === 'actions')).toBeUndefined();
    const header = (blocks[0] as { text: { text: string } }).text.text;
    expect(header).toContain('Workflow completed');
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('total cost: $0.1230');
  });

  test('terminal failed snapshot shows reason', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        terminal: 'failed',
        failureReason: 'Type error in plan node',
      }),
      startedAt + 1000
    );
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('reason: Type error in plan node');
  });

  test('terminal cancelled snapshot also surfaces reason', () => {
    const { blocks } = buildStatusBlocks(
      snapshot({
        terminal: 'cancelled',
        failureReason: 'user clicked cancel',
      }),
      startedAt + 1000
    );
    const ctx = blocks.find(b => (b as { type: string }).type === 'context') as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0]?.text).toContain('reason: user clicked cancel');
  });
});

describe('reaction name constants', () => {
  test('are stable Slack emoji names', () => {
    expect(REACTION_RUNNING).toBe('arrows_counterclockwise');
    expect(REACTION_SUCCESS).toBe('white_check_mark');
    expect(REACTION_FAILURE).toBe('x');
  });
});
