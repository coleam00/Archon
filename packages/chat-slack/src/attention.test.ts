import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { BlockAction, types } from '@slack/bolt';
import type {
  ChatAttentionNotice,
  ChatContext,
  ChatRunActionResponse,
} from '@archon/chat-contract';
import { SlackAdapter } from './adapter';
import { SlackPlugin } from './plugin';
import { StubSlack } from './test/slack';

let slack: StubSlack;
let plugin: SlackPlugin;
let runAction: ReturnType<typeof mock<ChatContext['runAction']>>;
const saved = { bot: process.env.SLACK_BOT_TOKEN, app: process.env.SLACK_APP_TOKEN };
spyOn(console, 'error').mockImplementation(() => {});
beforeEach(async () => {
  process.env.SLACK_BOT_TOKEN = 'bot';
  process.env.SLACK_APP_TOKEN = 'app';
  slack = new StubSlack();
  plugin = new SlackPlugin(new SlackAdapter(() => slack.asApp()));
  runAction = mock(async () => ({
    status: 'done',
    result: { kind: 'answered', resumed: true },
  }));
  await plugin.start({ inbound: async () => ({ status: 'accepted' }), runAction });
});
afterEach(async () => {
  await plugin.stop();
  if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = saved.bot;
  if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
  else process.env.SLACK_APP_TOKEN = saved.app;
});

const paused = { runId: 'run-1', workflowName: 'deploy', nodeId: 'ask', pauseId: 'p1' };
type WaitNotice = Extract<ChatAttentionNotice, { type: 'attention' }>;
function wait(form: WaitNotice['form'], options: WaitNotice['options'] = []): WaitNotice {
  return { type: 'attention', ...paused, message: 'Which region?', form, options };
}
async function notify(notice: ChatAttentionNotice, destination = 'C9'): Promise<string> {
  const { conversationId } = await plugin.attentionNotice({ destination, notice });
  if (!conversationId) throw new Error('notice opened no conversation');
  return conversationId;
}
function blocksOf(index: number): (types.KnownBlock | types.Block)[] {
  const post = slack.posts.at(index);
  return post && 'blocks' in post && post.blocks ? post.blocks : [];
}
function buttons(): types.Button[] {
  return blocksOf(-1).flatMap(block =>
    block.type === 'actions' && 'elements' in block
      ? (block.elements as types.ActionsBlockElement[]).filter(
          (element): element is types.Button => element.type === 'button'
        )
      : []
  );
}
function button(label: string): types.Button {
  const found = buttons().find(element => element.text.text === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}
async function click(
  control: types.Button,
  state?: BlockAction['state'],
  user = 'U1'
): Promise<void> {
  const handler = slack.actions.find(entry => entry.pattern.test(control.action_id ?? ''));
  if (!handler) throw new Error('missing action handler');
  await handler.handler({
    ack: async () => {},
    body: {
      user: { id: user },
      channel: { id: 'C9' },
      message: { ts: 'msg-1' },
      trigger_id: 'trigger',
      state,
    } as BlockAction,
    action: { type: 'button', action_id: control.action_id, value: control.value } as never,
  });
}
async function submit(text: string, metadata?: string): Promise<void> {
  const view = slack.opened.at(-1)?.view;
  const handler = slack.views.get('attention:compose');
  if (!handler || (metadata === undefined && !view)) throw new Error('no open answer form');
  const submitted = {
    private_metadata: metadata ?? view?.private_metadata ?? '',
    state: { values: { 'attention:compose': { 'attention:compose': { type: 'x', value: text } } } },
  } as never;
  await handler({
    ack: async () => {},
    body: { user: { id: 'U1' }, view: submitted } as never,
    view: submitted,
  });
}
function sent(): unknown {
  return runAction.mock.calls.at(-1)?.[0];
}

test('a gate posts to the destination with its decisions and answers with the pause identity', async () => {
  const conversationId = await notify({
    type: 'gate',
    ...paused,
    gateType: 'approval',
    message: 'Ship it?',
    decisions: [{ id: 'approve' }, { id: 'reject' }],
  });
  expect(conversationId).toBe('C9:msg-1');
  expect(slack.posts[0]).toMatchObject({ channel: 'C9', text: expect.stringContaining('deploy') });
  expect(JSON.stringify(blocksOf(0))).toContain('Needs attention');
  expect(buttons().map(element => element.text.text)).toEqual(['Approve', 'Reject']);

  runAction.mockResolvedValueOnce({
    status: 'done',
    result: { kind: 'approved', type: 'approval_gate', resumed: true },
  });
  await click(button('Approve'));
  expect(sent()).toEqual({
    action: 'respond',
    runId: 'run-1',
    sender: { platformUserId: 'U1' },
    response: { nodeId: 'ask', pauseId: 'p1', decision: 'approve' },
  });
  const settled = JSON.stringify(slack.updates.at(-1));
  expect(settled).toContain('Approved by <@U1>');
  expect(settled).toContain('Ship it?');
  expect(settled).not.toContain('actions');
});

test('an interactive loop gate replies through a modal as approval with feedback', async () => {
  await notify({
    type: 'gate',
    ...paused,
    gateType: 'interactive_loop',
    message: 'Review the draft',
    decisions: [{ id: 'approve' }, { id: 'reject' }],
  });
  await click(button('Reply'));
  expect(slack.opened[0]).toMatchObject({ trigger_id: 'trigger' });
  expect(runAction).not.toHaveBeenCalled();
  await submit('Tighten the intro');
  expect(sent()).toEqual({
    action: 'respond',
    runId: 'run-1',
    sender: { platformUserId: 'U1' },
    response: { nodeId: 'ask', pauseId: 'p1', decision: 'approve', text: 'Tighten the intro' },
  });
  expect(JSON.stringify(slack.updates.at(-1))).toContain('Replied by <@U1>');
});

test('a message wait answers its text through a modal', async () => {
  await notify(wait('message'));
  await click(button('Answer'));
  await submit('eu-west-1');
  expect(sent()).toEqual({
    action: 'answer',
    runId: 'run-1',
    sender: { platformUserId: 'U1' },
    response: { nodeId: 'ask', pauseId: 'p1', choose: [], text: 'eu-west-1' },
  });
});

for (const form of ['approval', 'select'] as const) {
  test(`a ${form} wait chooses one option per button`, async () => {
    await notify(
      wait(
        form,
        form === 'approval'
          ? [{ id: 'approve' }, { id: 'reject' }]
          : [
              { id: 'eu', label: 'Europe' },
              { id: 'us', label: 'United States' },
            ]
      )
    );
    const label = form === 'approval' ? 'Reject' : 'Europe';
    await click(button(label));
    expect(sent()).toMatchObject({
      action: 'answer',
      response: { nodeId: 'ask', pauseId: 'p1', choose: [form === 'approval' ? 'reject' : 'eu'] },
    });
    expect(buttons().some(element => element.action_id === 'cancel:run-1')).toBe(true);
  });
}

test('a multi-select wait submits every picked option', async () => {
  await notify(wait('multi_select', [{ id: 'eu' }, { id: 'us' }, { id: 'ap' }]));
  const picked = {
    type: 'multi_static_select',
    selected_options: [
      { text: { type: 'plain_text' as const, text: 'eu' }, value: 'eu' },
      { text: { type: 'plain_text' as const, text: 'ap' }, value: 'ap' },
    ],
  };
  await click(button('Submit'), { values: { 'attention:pick': { 'attention:pick': picked } } });
  expect(sent()).toMatchObject({ action: 'answer', response: { choose: ['eu', 'ap'] } });
  expect(JSON.stringify(slack.updates.at(-1))).toContain('Chose eu, ap by <@U1>');
});

test('an answer form that cannot open tells the member', async () => {
  await notify(wait('message'));
  slack.failOpen = new Error('expired_trigger_id');
  await click(button('Answer'));
  expect(slack.ephemerals).toEqual([
    expect.objectContaining({ user: 'U1', text: expect.stringContaining('Could not open') }),
  ]);
});

test('an unreadable answer form submission tells the member and sends nothing', async () => {
  await notify(wait('message'));
  await submit('eu-west-1', JSON.stringify({ notice: { channel: 'C9', ts: 'msg-1' } }));
  expect(runAction).not.toHaveBeenCalled();
  expect(slack.ephemerals).toEqual([
    expect.objectContaining({ user: 'U1', text: expect.stringContaining('could not be read') }),
  ]);
});

test('an answer to a notice the plugin no longer remembers still settles it', async () => {
  await notify(wait('select', [{ id: 'eu' }]));
  const control = button('eu');
  await plugin.stop();
  slack = new StubSlack();
  plugin = new SlackPlugin(new SlackAdapter(() => slack.asApp()));
  await plugin.start({ inbound: async () => ({ status: 'accepted' }), runAction });
  await click(control);
  expect(slack.updates).toEqual([
    expect.objectContaining({ ts: 'msg-1', text: expect.stringContaining('Chose eu by <@U1>') }),
  ]);
  expect(slack.posts).toEqual([]);
});

test('a wait without a pause id offers resume', async () => {
  await notify({ ...wait('select', [{ id: 'eu' }]), pauseId: undefined });
  expect(buttons().map(element => element.text.text)).toEqual(['Resume', 'Cancel']);
  await click(button('Resume'));
  expect(sent()).toEqual({ action: 'resume', runId: 'run-1', sender: { platformUserId: 'U1' } });
});

const outcomes: [string, ChatRunActionResponse, 'ephemerals' | 'posts'][] = [
  ['forbidden', { status: 'forbidden', message: 'Only the starter may act' }, 'ephemerals'],
  ['refused', { status: 'refused', message: 'That pause is no longer open' }, 'posts'],
];
for (const [status, response, surface] of outcomes) {
  test(`a ${status} answer is shown to the member and leaves the notice open`, async () => {
    await notify(wait('select', [{ id: 'eu' }]));
    runAction.mockResolvedValueOnce(response);
    await click(button('eu'), undefined, 'U2');
    expect(JSON.stringify(slack[surface].at(-1))).toContain(
      'message' in response ? response.message : ''
    );
    expect(slack.updates).toEqual([]);
  });
}

test('a destination thread hosts the notice, and the follow-up closes it in that thread', async () => {
  const conversationId = await notify(wait('select', [{ id: 'eu' }]), 'C9:100.1');
  expect(slack.posts[0]).toMatchObject({ channel: 'C9', thread_ts: '100.1' });
  expect(conversationId).toBe('C9:100.1');
  await plugin.attentionNotice({
    destination: 'C9:100.1',
    conversationId,
    notice: {
      type: 'terminal',
      runId: 'run-1',
      workflowName: 'deploy',
      status: 'completed',
      totalCostUsd: 0.5,
    },
  });
  expect(slack.posts[1]).toMatchObject({ channel: 'C9', thread_ts: '100.1' });
  expect(JSON.stringify(blocksOf(1))).toContain('total cost: $0.5000');
  expect(slack.updates).toEqual([
    expect.objectContaining({
      channel: 'C9',
      ts: 'msg-1',
      text: expect.stringContaining('Closed'),
    }),
  ]);
});

test('a failed terminal post still closes the run notices, and the failure surfaces', async () => {
  await notify(wait('select', [{ id: 'eu' }]));
  slack.failPost = new Error('channel_not_found');
  await expect(
    plugin.attentionNotice({
      destination: 'C9',
      notice: { type: 'terminal', runId: 'run-1', workflowName: 'deploy', status: 'failed' },
    })
  ).rejects.toThrow('channel_not_found');
  expect(slack.updates).toEqual([
    expect.objectContaining({ ts: 'msg-1', text: expect.stringContaining('Closed') }),
  ]);
});

test('a finished run closes only its own notices, and another run keeps live controls', async () => {
  await notify(wait('select', [{ id: 'eu' }]));
  await notify({ ...wait('select', [{ id: 'us' }]), runId: 'run-2' });
  const otherRun = button('us');
  await plugin.attentionNotice({
    destination: 'C9',
    notice: { type: 'terminal', runId: 'run-1', workflowName: 'deploy', status: 'completed' },
  });
  expect(slack.updates).toEqual([
    expect.objectContaining({ ts: 'msg-1', text: expect.stringContaining('Closed') }),
  ]);
  await click(otherRun);
  expect(sent()).toMatchObject({ action: 'answer', runId: 'run-2' });
});

test('options beyond Slack limits render the notice without controls', async () => {
  await notify(
    wait(
      'multi_select',
      Array.from({ length: 101 }, (_, index) => ({ id: `o${String(index)}` }))
    )
  );
  expect(buttons()).toEqual([]);
  expect(JSON.stringify(blocksOf(0))).toContain('answer in Archon');
});
