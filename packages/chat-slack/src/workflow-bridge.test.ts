import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { BlockButtonAction, ButtonAction } from '@slack/bolt';
import type { ChatContext, ChatRunActionResponse, RunActionResult } from '@archon/chat-contract';
import { SlackAdapter } from './adapter';
import { SlackPlugin } from './plugin';
import { resolutionNote } from './workflow-bridge';
import { StubSlack } from './test/slack';

let slack: StubSlack;
let adapter: SlackAdapter;
let plugin: SlackPlugin;
let runAction: ReturnType<typeof mock<ChatContext['runAction']>>;
const saved = { bot: process.env.SLACK_BOT_TOKEN, app: process.env.SLACK_APP_TOKEN };
spyOn(console, 'error').mockImplementation(() => {});
beforeEach(async () => {
  process.env.SLACK_BOT_TOKEN = 'bot';
  process.env.SLACK_APP_TOKEN = 'app';
  slack = new StubSlack();
  adapter = new SlackAdapter(() => slack.asApp());
  plugin = new SlackPlugin(adapter);
  runAction = mock(async () => ({
    status: 'done',
    result: { kind: 'approved', type: 'approval_gate', resumed: true },
  }));
  await plugin.start({ inbound: async () => ({ status: 'accepted' }), runAction });
  await adapter.receive({ channel: 'C1', ts: '1', user: 'U1', text: 'run' });
});
afterEach(async () => {
  await plugin.stop();
  if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = saved.bot;
  if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
  else process.env.SLACK_APP_TOKEN = saved.app;
});
async function started(): Promise<void> {
  await plugin.onRunEvent({
    type: 'workflow_started',
    runId: 'run',
    workflowName: 'assist',
    conversationId: 'C1:1',
  });
}
async function approval(): Promise<void> {
  await plugin.onRunEvent({
    type: 'approval_pending',
    runId: 'run',
    nodeId: 'review',
    pauseId: 'pause',
    message: 'Ship?',
    decisions: [{ id: 'ship', label: 'Ship it' }],
  });
}
async function click(action_id: string, value?: string): Promise<void> {
  const handler = slack.actions.find(action => action.pattern.test(action_id));
  if (!handler) throw new Error('missing action');
  await handler.handler({
    ack: async () => {},
    body: {
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: 'msg-2' },
    } as BlockButtonAction,
    action: { type: 'button', action_id, value } as ButtonAction,
  });
}
function rendered(): string {
  return JSON.stringify(slack.updates);
}

test('started runs react to their trigger and post a threaded status with cancel', async () => {
  await started();
  expect(slack.added).toEqual([{ channel: 'C1', timestamp: '1', name: 'arrows_counterclockwise' }]);
  expect(slack.posts[0]).toMatchObject({
    channel: 'C1',
    thread_ts: '1',
    text: expect.stringContaining('assist'),
  });
  expect(JSON.stringify(slack.posts)).toContain('cancel:run');
});
test('host-owned conversations render after restart without an in-memory trigger', async () => {
  await plugin.onRunEvent({
    type: 'workflow_started',
    runId: 'run',
    workflowName: 'assist',
    conversationId: 'C2:2',
  });
  expect(slack.posts[0]).toMatchObject({ channel: 'C2', thread_ts: '2' });
  expect(slack.added).toHaveLength(0);
});
test('node bursts debounce status edits and preserve node arrival order', async () => {
  await started();
  for (const state of ['running', 'completed'] as const)
    await plugin.onRunEvent({
      type: 'node_state',
      runId: 'run',
      nodeId: 'plan',
      nodeName: 'plan',
      state,
      durationMs: 4000,
    });
  await plugin.onRunEvent({
    type: 'node_state',
    runId: 'run',
    nodeId: 'apply',
    nodeName: 'apply',
    state: 'failed',
    error: 'boom',
  });
  expect(slack.updates).toHaveLength(0);
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(slack.updates).toHaveLength(1);
  expect(rendered()).toContain('4s');
  expect(rendered()).toContain('boom');
  expect(rendered().indexOf('plan')).toBeLessThan(rendered().indexOf('apply'));
});
test('approval renders host-supplied decisions and exact gate identity', async () => {
  await started();
  await approval();
  expect(rendered()).toContain('Workflow paused');
  expect(JSON.stringify(slack.posts[1])).toContain('Ship it');
  await click(
    'respond:0',
    JSON.stringify({ runId: 'run', nodeId: 'review', pauseId: 'pause', decision: 'ship' })
  );
  expect(runAction).toHaveBeenCalledWith({
    action: 'respond',
    runId: 'run',
    sender: { platformUserId: 'U1' },
    response: { nodeId: 'review', pauseId: 'pause', decision: 'ship' },
  });
  expect(rendered()).toContain('Selected ship');
  expect(rendered()).toContain('workflow resumed');
  expect(rendered()).toContain('Ship?');
});
test('legacy action IDs with colon-containing node IDs remain usable', async () => {
  await started();
  await click('approve:run:parent:review');
  expect(runAction.mock.calls[0]?.[0]).toMatchObject({
    response: { decision: 'approve', nodeId: 'parent:review' },
  });
});
test('invalid button values never dispatch an action', async () => {
  for (const value of [
    '{',
    JSON.stringify({ runId: 'run' }),
    JSON.stringify({ runId: 'run', decision: 5 }),
  ])
    await click('respond:0', value);
  expect(runAction).not.toHaveBeenCalled();
});
for (const status of ['completed', 'failed', 'cancelled'] as const) {
  test(`${status} removes controls, closes approvals, shows final facts and clears trigger`, async () => {
    await started();
    await approval();
    await plugin.onRunEvent({
      type: 'node_state',
      runId: 'run',
      nodeId: 'review',
      nodeName: 'review',
      state: 'running',
    });
    await plugin.onRunEvent({
      type: 'terminal',
      runId: 'run',
      status,
      authoredOutcome: 'failed',
      totalCostUsd: 0.0234,
      error: status === 'completed' ? undefined : 'reason',
    });
    expect(rendered()).toContain('approval closed');
    expect(rendered()).toContain('Authored outcome');
    expect(rendered()).toContain('0.0234');
    expect(JSON.stringify(slack.updates.slice(-2))).not.toContain('cancel:run');
    expect(adapter.getTriggeringMessage('C1:1')).toBeUndefined();
    expect(slack.removed[0]?.name).toBe('arrows_counterclockwise');
    if (status === 'completed')
      expect(slack.added.map(reaction => reaction.name)).toContain('white_check_mark');
    expect(slack.added.map(reaction => reaction.name)).toContain('x');
  });
}
test('event rendering preserves emission order through a slow initial post', async () => {
  let release = (): void => {};
  slack.postBarrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const beginning = started();
  const ending = plugin.onRunEvent({ type: 'terminal', runId: 'run', status: 'completed' });
  await Promise.resolve();
  release();
  await Promise.all([beginning, ending]);
  expect(rendered()).toContain('Workflow completed');
});
test('renderer failures do not poison subsequent events', async () => {
  slack.failPost = new Error('fixture failure');
  await expect(started()).rejects.toThrow('fixture failure');
  await started();
  await plugin.onRunEvent({ type: 'terminal', runId: 'run', status: 'completed' });
  expect(rendered()).toContain('Workflow completed');
});
for (const response of [
  { status: 'rejected', reason: 'not_allowed' },
  { status: 'forbidden', message: 'Only the starter or an admin' },
  { status: 'refused', message: 'No owner answered', abandonHint: '/archon-workflow abandon run' },
] satisfies ChatRunActionResponse[]) {
  for (const action of ['cancel:run', 'respond:0']) {
    test(`${action} renders host ${response.status} without editing controls`, async () => {
      await started();
      runAction.mockResolvedValue(response);
      await click(
        action,
        action === 'respond:0'
          ? JSON.stringify({ runId: 'run', nodeId: 'review', decision: 'ship' })
          : undefined
      );
      expect(runAction).toHaveBeenCalledTimes(1);
      expect(slack.updates).toHaveLength(0);
      if (response.status === 'rejected') {
        expect(slack.ephemerals).toHaveLength(0);
        expect(slack.posts).toHaveLength(1);
      }
      if (response.status === 'forbidden')
        expect(slack.ephemerals[0]).toMatchObject({
          text: expect.stringContaining(response.message),
        });
      if (response.status === 'refused')
        expect(JSON.stringify(slack.posts)).toContain(response.abandonHint);
    });
  }
}
test('cancel renders stopped-owner cleanup and cascade facts', async () => {
  await started();
  runAction.mockResolvedValue({
    status: 'done',
    result: {
      kind: 'stopped',
      pid: 123,
      cleanupWarnings: ['cleanup failed'],
      cascadeFailures: 2,
      blockedParentRunId: 'parent',
    },
  });
  await click('cancel:run');
  const notes = JSON.stringify(slack.posts);
  expect(notes).toContain('pid 123');
  expect(notes).toContain('cleanup failed');
  expect(notes).toContain('2 sub-run');
  expect(notes).toContain('parent');
});
test('cancel after terminal uses clicked message as the fallback target', async () => {
  await started();
  await plugin.onRunEvent({ type: 'terminal', runId: 'run', status: 'completed' });
  runAction.mockResolvedValue({
    status: 'done',
    result: { kind: 'cooperative', cancelled: false },
  });
  await click('cancel:run');
  expect(slack.posts.at(-1)).toMatchObject({
    channel: 'C1',
    thread_ts: 'msg-2',
    text: expect.stringContaining('already finished'),
  });
});
test('action RPC failure gives a generic note', async () => {
  await started();
  runAction.mockRejectedValue(new Error('database private details'));
  await click('cancel:run');
  expect(JSON.stringify(slack.posts)).toContain('Could not cancel');
  expect(JSON.stringify(slack.posts)).not.toContain('private details');
});
test('paused approvals retain their authored outcome during a pending node edit', async () => {
  await started();
  await plugin.onRunEvent({
    type: 'node_state',
    runId: 'run',
    nodeId: 'review',
    nodeName: 'review',
    state: 'running',
  });
  await plugin.onRunEvent({
    type: 'approval_pending',
    runId: 'run',
    nodeId: 'review',
    message: 'Choose',
    authoredOutcome: 'succeeded',
  });
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(JSON.stringify(slack.updates.at(-1))).toContain('Workflow paused');
  expect(JSON.stringify(slack.updates.at(-1))).toContain('succeeded');
});

test('prior-success replay preserves completed duration and suspended nodes stay running', async () => {
  await started();
  await plugin.onRunEvent({
    type: 'node_state',
    runId: 'run',
    nodeId: 'plan',
    nodeName: 'plan',
    state: 'completed',
    durationMs: 4000,
  });
  await plugin.onRunEvent({
    type: 'node_state',
    runId: 'run',
    nodeId: 'plan',
    nodeName: 'plan',
    state: 'completed',
  });
  await plugin.onRunEvent({
    type: 'node_state',
    runId: 'run',
    nodeId: 'review',
    nodeName: 'review',
    state: 'running',
  });
  await plugin.onRunEvent({ type: 'terminal', runId: 'run', status: 'completed' });
  expect(rendered()).toContain('4s');
  expect(rendered()).toContain(':hourglass_flowing_sand: `review`');
});

test('gate notes retain resume and rejection distinctions', () => {
  const results: RunActionResult[] = [
    { kind: 'approved', type: 'approval_gate', resumed: true },
    { kind: 'approved', type: 'interactive_loop', resumed: true },
    { kind: 'approved', type: 'approval_gate', resumed: false },
    {
      kind: 'rejected',
      cancelled: true,
      maxAttemptsReached: true,
      writeBack: false,
      newMode: false,
      resumed: false,
    },
    {
      kind: 'rejected',
      cancelled: false,
      maxAttemptsReached: false,
      writeBack: true,
      newMode: false,
      resumed: true,
    },
    {
      kind: 'rejected',
      cancelled: false,
      maxAttemptsReached: false,
      writeBack: false,
      newMode: true,
      resumed: true,
    },
  ];
  expect(results.map(resolutionNote)).toEqual([
    'workflow resumed',
    expect.stringContaining('otherwise the loop runs another iteration'),
    expect.stringContaining('resume was not accepted'),
    'cancelled — max reject attempts reached',
    'recorded — workflow resumed to discard the container changes',
    'recorded — workflow resumed',
  ]);
});

test('a terminal event closes an approval whose Slack post was still pending on arrival', async () => {
  await started();
  let release = (): void => {};
  slack.postBarrier = new Promise<void>(resolve => {
    release = resolve;
  });
  const posting = approval();
  const terminal = plugin.onRunEvent({ type: 'terminal', runId: 'run', status: 'cancelled' });
  await Promise.resolve();
  release();
  await Promise.all([posting, terminal]);
  const closed = slack.updates.find(update => update.ts === 'msg-2');
  expect(closed).toMatchObject({ text: expect.stringContaining('Approval closed') });
  expect(JSON.stringify(closed)).not.toContain('respond:0');
});
