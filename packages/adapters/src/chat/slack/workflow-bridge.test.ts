/**
 * Unit tests for SlackWorkflowBridge.
 *
 * Mocks @archon/workflows/event-emitter and @archon/core so we can drive
 * synthetic events through the bridge and assert the resulting Slack API
 * calls (chat.postMessage / chat.update / reactions.add).
 *
 * NOTE: this file uses mock.module() which is process-global and irreversible
 * in Bun. Adapter package.json keeps this test in its own `bun test`
 * invocation so it doesn't pollute other suites.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockGetConversationId = mock<(runId: string) => string | undefined>(() => undefined);
let capturedListener: ((event: WorkflowEmitterEvent) => void) | undefined;
const mockSubscribe = mock((listener: (event: WorkflowEmitterEvent) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = undefined;
  };
});

mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: () => ({
    subscribe: mockSubscribe,
    getConversationId: mockGetConversationId,
    registerRun: mock(() => {}),
    unregisterRun: mock(() => {}),
    emit: mock(() => {}),
  }),
}));

const mockApproveWorkflow = mock<
  (runId: string, comment?: string) => Promise<{ type: 'approval_gate' | 'interactive_loop' }>
>(async () => ({ type: 'approval_gate' }));
const mockRejectWorkflow = mock<
  (runId: string, reason?: string) => Promise<{ cancelled: boolean; maxAttemptsReached: boolean }>
>(async () => ({ cancelled: false, maxAttemptsReached: false }));
const mockAbandonWorkflow = mock<(runId: string) => Promise<unknown>>(async () => ({}));
const mockGetWorkflowRun = mock<
  (runId: string) => Promise<{ metadata: Record<string, unknown> } | null>
>(async () => ({ metadata: { total_cost_usd: 0.0234 } }));

mock.module('@archon/core', () => ({
  workflowOperations: {
    approveWorkflow: mockApproveWorkflow,
    rejectWorkflow: mockRejectWorkflow,
    abandonWorkflow: mockAbandonWorkflow,
  },
  workflowDb: {
    getWorkflowRun: mockGetWorkflowRun,
  },
}));

// Imports must come AFTER mock.module setup.
const { SlackWorkflowBridge } = await import('./workflow-bridge');
const { isSlackUserAuthorized } = await import('./auth');
// reference to silence unused import lint — we exercise the auth path indirectly.
void isSlackUserAuthorized;

// ─── Test doubles for the SlackAdapter ────────────────────────────────────

interface PostedMessage {
  channel: string;
  thread_ts?: string;
  text?: string;
  blocks?: unknown[];
}

interface UpdatedMessage {
  channel: string;
  ts: string;
  text?: string;
  blocks?: unknown[];
}

interface ReactionCall {
  channel: string;
  timestamp: string;
  name: string;
}

function makeFakeAdapter(allowedUserIds: string[] = []) {
  const posted: PostedMessage[] = [];
  const updated: UpdatedMessage[] = [];
  const reactionsAdded: ReactionCall[] = [];
  const reactionsRemoved: ReactionCall[] = [];
  let nextTs = 1;

  let registeredActions: Array<{ pattern: RegExp; handler: (args: unknown) => Promise<void> }> = [];

  const triggerMap = new Map<string, { channel: string; ts: string }>();

  const fakeApp = {
    client: {
      chat: {
        postMessage: mock(async (args: PostedMessage) => {
          posted.push(args);
          return { ts: `${nextTs++}.000` };
        }),
        update: mock(async (args: UpdatedMessage) => {
          updated.push(args);
          return { ok: true };
        }),
      },
      reactions: {
        add: mock(async (args: ReactionCall) => {
          reactionsAdded.push(args);
          return { ok: true };
        }),
        remove: mock(async (args: ReactionCall) => {
          reactionsRemoved.push(args);
          return { ok: true };
        }),
      },
    },
    action: mock((pattern: RegExp, handler: (args: unknown) => Promise<void>) => {
      registeredActions.push({ pattern, handler });
    }),
  };

  const fakeAdapter = {
    getApp: () => fakeApp,
    getTriggeringMessage: (id: string) => triggerMap.get(id),
    clearTriggeringMessage: (id: string) => {
      triggerMap.delete(id);
    },
    getAllowedUserIds: () => allowedUserIds,
  };

  return {
    adapter: fakeAdapter,
    fakeApp,
    posted,
    updated,
    reactionsAdded,
    reactionsRemoved,
    triggerMap,
    actions: () => registeredActions,
    dispatchAction: async (actionId: string, body: Record<string, unknown>) => {
      for (const { pattern, handler } of registeredActions) {
        if (pattern.test(actionId)) {
          await handler({
            ack: async () => undefined,
            body,
            action: { action_id: actionId },
          });
        }
      }
    },
  };
}

async function dispatchEvent(event: WorkflowEmitterEvent): Promise<void> {
  if (!capturedListener) throw new Error('bridge not attached');
  capturedListener(event);
  // Let any awaited promises in the handler settle.
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SlackWorkflowBridge', () => {
  beforeEach(() => {
    mockGetConversationId.mockReset();
    mockSubscribe.mockClear();
    mockApproveWorkflow.mockReset();
    mockApproveWorkflow.mockResolvedValue({ type: 'approval_gate' });
    mockRejectWorkflow.mockReset();
    mockRejectWorkflow.mockResolvedValue({ cancelled: false, maxAttemptsReached: false });
    mockAbandonWorkflow.mockReset();
    mockAbandonWorkflow.mockResolvedValue({});
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockResolvedValue({ metadata: { total_cost_usd: 0.0234 } });
    capturedListener = undefined;
  });

  afterEach(() => {
    // No mock.restore() — see file header.
  });

  test('does nothing when there is no Slack trigger for the conversation', async () => {
    const { adapter, posted } = makeFakeAdapter();
    mockGetConversationId.mockReturnValue('C1:111.0');

    // SUT
    new SlackWorkflowBridge(adapter as never).attach();

    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });

    expect(posted).toHaveLength(0);
  });

  test('workflow_started posts a status message and adds running reaction', async () => {
    const { adapter, posted, reactionsAdded, triggerMap } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();

    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });

    expect(reactionsAdded).toContainEqual({
      channel: 'C1',
      timestamp: '111.0',
      name: 'arrows_counterclockwise',
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.channel).toBe('C1');
    expect(posted[0]?.thread_ts).toBe('111.0');
    expect(posted[0]?.text).toContain('running');
  });

  test('approval_pending posts a Block Kit approve/reject prompt in-thread', async () => {
    const { adapter, posted, triggerMap } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();

    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Approve the change?',
    });

    expect(posted.length).toBeGreaterThanOrEqual(2);
    const approval = posted[posted.length - 1];
    expect(approval?.thread_ts).toBe('111.0');
    expect(approval?.text).toContain('Approval needed');
    const actionsBlock = (approval?.blocks ?? []).find(
      (b: { type?: string }) => b?.type === 'actions'
    ) as { elements?: Array<{ action_id?: string }> } | undefined;
    expect(actionsBlock?.elements?.[0]?.action_id).toBe('approve:r1:review');
    expect(actionsBlock?.elements?.[1]?.action_id).toBe('reject:r1:review');
  });

  test('approve button calls approveWorkflow and edits the message', async () => {
    const { adapter, posted, updated, triggerMap, dispatchAction } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Approve the change?',
    });

    const approvalTs = posted[posted.length - 1]?.thread_ts; // unused but ensure thread_ts captured
    void approvalTs;

    await dispatchAction('approve:r1:review', {
      user: { id: 'U123' },
      channel: { id: 'C1' },
      message: { ts: '2.000' },
    });

    expect(mockApproveWorkflow).toHaveBeenCalledTimes(1);
    expect(mockApproveWorkflow).toHaveBeenCalledWith('r1');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.channel).toBe('C1');
    expect(updated[0]?.ts).toBe('2.000');
    const headerText = (updated[0]?.blocks?.[0] as { text?: { text?: string } } | undefined)?.text
      ?.text;
    expect(headerText).toContain('Approved');
    expect(headerText).toContain('<@U123>');
    expect(headerText).toContain('workflow resumed');
  });

  test('reject button under retry threshold notes workflow will retry', async () => {
    const { adapter, updated, triggerMap, dispatchAction } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');
    mockRejectWorkflow.mockResolvedValue({ cancelled: false, maxAttemptsReached: false });

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Approve?',
    });

    await dispatchAction('reject:r1:review', {
      user: { id: 'U999' },
      channel: { id: 'C1' },
      message: { ts: '2.000' },
    });

    expect(mockRejectWorkflow).toHaveBeenCalledTimes(1);
    const text = (updated[0]?.blocks?.[0] as { text?: { text?: string } } | undefined)?.text?.text;
    expect(text).toContain('Rejected');
    expect(text).toContain('will retry');
  });

  test('reject button at max attempts notes the run was cancelled', async () => {
    const { adapter, updated, triggerMap, dispatchAction } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');
    mockRejectWorkflow.mockResolvedValue({ cancelled: true, maxAttemptsReached: true });

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Approve?',
    });

    await dispatchAction('reject:r1:review', {
      user: { id: 'U999' },
      channel: { id: 'C1' },
      message: { ts: '2.000' },
    });

    expect(mockRejectWorkflow).toHaveBeenCalledTimes(1);
    const text = (updated[0]?.blocks?.[0] as { text?: { text?: string } } | undefined)?.text?.text;
    expect(text).toContain('Rejected');
    expect(text).toContain('max reject attempts reached');
  });

  test('cancel button calls abandonWorkflow', async () => {
    const { adapter, triggerMap, dispatchAction } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });

    await dispatchAction('cancel:r1', {
      user: { id: 'U123' },
      channel: { id: 'C1' },
      message: { ts: '1.000' },
    });

    expect(mockAbandonWorkflow).toHaveBeenCalledTimes(1);
    expect(mockAbandonWorkflow).toHaveBeenCalledWith('r1');
  });

  test('unauthorized click is silently dropped and no operation runs', async () => {
    const { adapter, triggerMap, dispatchAction } = makeFakeAdapter(['U_ALLOWED']);
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'approval_pending',
      runId: 'r1',
      nodeId: 'review',
      message: 'Approve?',
    });

    await dispatchAction('approve:r1:review', {
      user: { id: 'U_NOT_ALLOWED' },
      channel: { id: 'C1' },
      message: { ts: '2.000' },
    });

    expect(mockApproveWorkflow).not.toHaveBeenCalled();
  });

  test('workflow_completed swaps reaction and posts terminal status with cost', async () => {
    const { adapter, updated, reactionsAdded, reactionsRemoved, triggerMap } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'workflow_completed',
      runId: 'r1',
      workflowName: 'assist',
      duration: 1234,
    });

    expect(reactionsRemoved).toContainEqual({
      channel: 'C1',
      timestamp: '111.0',
      name: 'arrows_counterclockwise',
    });
    expect(reactionsAdded).toContainEqual({
      channel: 'C1',
      timestamp: '111.0',
      name: 'white_check_mark',
    });
    expect(updated.length).toBeGreaterThan(0);
    const ctx = (updated[updated.length - 1]?.blocks ?? []).find(
      (b: { type?: string }) => b?.type === 'context'
    ) as { elements?: Array<{ text?: string }> } | undefined;
    expect(ctx?.elements?.[0]?.text).toContain('total cost: $0.0234');
  });

  test('workflow_failed swaps reaction to x and includes failure reason', async () => {
    const { adapter, updated, reactionsAdded, triggerMap } = makeFakeAdapter();
    triggerMap.set('C1:111.0', { channel: 'C1', ts: '111.0' });
    mockGetConversationId.mockReturnValue('C1:111.0');
    mockGetWorkflowRun.mockResolvedValue({ metadata: {} });

    new SlackWorkflowBridge(adapter as never).attach();
    await dispatchEvent({
      type: 'workflow_started',
      runId: 'r1',
      workflowName: 'assist',
      conversationId: 'conv-db-uuid',
    });
    await dispatchEvent({
      type: 'workflow_failed',
      runId: 'r1',
      workflowName: 'assist',
      error: 'plan node crashed',
    });

    expect(reactionsAdded).toContainEqual({
      channel: 'C1',
      timestamp: '111.0',
      name: 'x',
    });
    const ctx = (updated[updated.length - 1]?.blocks ?? []).find(
      (b: { type?: string }) => b?.type === 'context'
    ) as { elements?: Array<{ text?: string }> } | undefined;
    expect(ctx?.elements?.[0]?.text).toContain('plan node crashed');
  });
});
