import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { App, SlashCommand } from '@slack/bolt';
import type { ChatContext } from '@archon/chat-contract';
import { SlackAdapter, splitMessage, stripBotMention } from './adapter';
import { SlackPlugin } from './plugin';
import { descriptor } from './descriptor';
import { StubSlack } from './test/slack';

let slack: StubSlack;
let adapter: SlackAdapter;
let plugin: SlackPlugin;
let inbound: ReturnType<typeof mock<ChatContext['inbound']>>;
const saved = { bot: process.env.SLACK_BOT_TOKEN, app: process.env.SLACK_APP_TOKEN };
const logs = spyOn(console, 'error').mockImplementation(() => {});
beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = 'bot';
  process.env.SLACK_APP_TOKEN = 'app';
  slack = new StubSlack();
  adapter = new SlackAdapter(() => slack.asApp());
  plugin = new SlackPlugin(adapter);
  inbound = mock(async () => ({ status: 'accepted' as const }));
  logs.mockClear();
});
afterEach(async () => {
  await plugin.stop();
  if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = saved.bot;
  if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
  else process.env.SLACK_APP_TOKEN = saved.app;
});
async function start(): Promise<void> {
  await plugin.start({
    inbound,
    runAction: async () => ({ status: 'rejected', reason: 'not_allowed' }),
  });
}
const event = {
  channel: 'C1',
  ts: '1',
  user: 'U1',
  text: '<@UABC> hello <https://archon.diy|Archon>',
};
async function slash(text: string, kind = '/archon'): Promise<string[]> {
  const notes: string[] = [];
  const handler = slack.commands.get(kind);
  if (!handler) throw new Error('missing command');
  // Bolt supplies more fields; this fixture selects the ones the handler reads.
  await handler({
    command: { text, user_id: 'U1', channel_id: 'C1' } as SlashCommand,
    ack: async () => {},
    respond: async (value: { text?: string } | string) => {
      notes.push(typeof value === 'string' ? value : (value.text ?? ''));
      return {};
    },
    client: slack.client,
    body: {},
    context: {},
    logger: {},
  } as unknown as Parameters<Parameters<App['command']>[1]>[0]);
  return notes;
}

test('registers every handler before opening Socket Mode and closes the client', async () => {
  await start();
  expect(slack.started).toBe(true);
  await plugin.stop();
  expect(slack.stopped).toBe(true);
});
for (const token of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
  test(`missing ${token} fails non-retryably before creating a client`, async () => {
    process.env[token] = '';
    await expect(start()).rejects.toMatchObject({ name: 'ChatStartError', retryable: false });
    expect(slack.started).toBe(false);
  });
}
test('mention normalization preserves prose and normalizes Slack links and reset', () => {
  expect(stripBotMention(event.text)).toBe('hello https://archon.diy');
  expect(stripBotMention(' ReSeT ')).toBe('/reset');
  expect(stripBotMention('please reset the repository')).toBe('please reset the repository');
});
test('mentions carry display names and retain the triggering message', async () => {
  await start();
  await slack.events.get('app_mention')!({ event });
  expect(inbound).toHaveBeenCalledWith({
    conversationId: 'C1:1',
    text: 'hello https://archon.diy',
    sender: { platformUserId: 'U1', displayName: 'Alice' },
    parentConversationId: undefined,
    threadContext: undefined,
  });
  expect(adapter.getTriggeringMessage('C1:1')).toEqual({ channel: 'C1', ts: '1' });
});
test('thread context excludes the current message by timestamp, even when replies follow it', async () => {
  await start();
  slack.replies = [
    { ts: '1', text: 'root', user: 'U2' },
    { ts: '2', text: 'current', user: 'U1' },
    { ts: '3', text: 'later', bot_id: 'B1' },
  ];
  await adapter.receive({ ...event, ts: '2', thread_ts: '1' });
  expect(inbound.mock.calls[0]?.[0]).toMatchObject({
    conversationId: 'C1:1',
    parentConversationId: 'C1:1',
    threadContext: '<@U2>: root\n[Bot]: later',
  });
});
test('handles DMs but ignores bot and channel message events', async () => {
  await start();
  const handler = slack.events.get('message')!;
  await handler({ event: { ...event, channel_type: 'channel' } });
  await handler({ event: { ...event, channel_type: 'im', bot_id: 'B1' } });
  expect(inbound).not.toHaveBeenCalled();
  await handler({ event: { ...event, channel_type: 'im' } });
  expect(inbound).toHaveBeenCalledTimes(1);
});
test('empty mentions and missing senders do not reach the host', async () => {
  await start();
  await adapter.receive({ ...event, text: '<@UABC>' });
  await adapter.receive({ ...event, user: '' });
  expect(inbound).not.toHaveBeenCalled();
});
test('display names are cached; failed lookups retry without leaking identities', async () => {
  await start();
  slack.failUser = new Error('U_SECRET C_SECRET Alice xoxb-secret');
  expect(await adapter.fetchDisplayName('U_SECRET')).toBeUndefined();
  expect(await adapter.fetchDisplayName('U_SECRET')).toBeUndefined();
  slack.failUser = undefined;
  expect(await adapter.fetchDisplayName('U_SECRET')).toBe('Alice');
  expect(await adapter.fetchDisplayName('U_SECRET')).toBe('Alice');
  expect(slack.userLookups).toBe(3);
  expect(JSON.stringify(logs.mock.calls)).not.toMatch(/U_SECRET|C_SECRET|Alice|xoxb-secret/);
  expect(logs.mock.calls[0]?.[0]).toContain('"platform":"slack"');
});
test('thread history failure leaves inbound usable and observable', async () => {
  await start();
  slack.failHistory = new Error('private channel');
  await adapter.receive({ ...event, ts: '2', thread_ts: '1' });
  expect(inbound).toHaveBeenCalledTimes(1);
  expect(logs).toHaveBeenCalled();
});
test('host rejection is silent and clears trigger state; the plugin has no local allowlist', async () => {
  await start();
  inbound.mockResolvedValue({ status: 'rejected', reason: 'not_allowed' });
  await adapter.receive(event);
  expect(inbound).toHaveBeenCalledTimes(1);
  expect(adapter.getTriggeringMessage('C1:1')).toBeUndefined();
  expect(slack.posts).toHaveLength(0);
});
test('RPC failure gives a generic delivery error without message or identity logs', async () => {
  await start();
  inbound.mockRejectedValue(new Error('U1 C1 private text'));
  await adapter.receive(event);
  expect(slack.posts[0]).toMatchObject({ text: expect.stringContaining('Could not deliver') });
  expect(JSON.stringify(logs.mock.calls)).not.toContain('private text');
});
test('slash commands seed threads and translate the registered workflow command', async () => {
  await start();
  expect((await slash('run assist', '/archon-workflow'))[0]).toContain(
    '/archon-workflow run assist'
  );
  expect(slack.posts[0]).toMatchObject({
    text: expect.stringContaining('/archon-workflow run assist'),
  });
  expect(inbound.mock.calls[0]?.[0]).toMatchObject({
    conversationId: 'C1:msg-1',
    text: '/workflow run assist',
  });
});
test('ordinary slash commands use the same inbound flow', async () => {
  await start();
  await slash('hello');
  expect(inbound.mock.calls[0]?.[0]).toMatchObject({ text: 'hello', conversationId: 'C1:msg-1' });
});
test('empty slash commands show help without seeding or dispatch', async () => {
  await start();
  expect((await slash(' '))[0]).toContain('Usage:');
  expect(slack.posts).toHaveLength(0);
  expect(inbound).not.toHaveBeenCalled();
});
test('GitHub connect points to supported surfaces without a seed or identity lookup', async () => {
  await start();
  const notes = await slash('connect github');
  expect(notes[0]).toContain('Web UI');
  expect(notes[0]).toContain('archon auth github');
  expect(slack.posts).toHaveLength(0);
  expect(slack.userLookups).toBe(0);
  expect(inbound).not.toHaveBeenCalled();
});
for (const missingTs of [true, false]) {
  test(`seed failure (${missingTs ? 'no ts' : 'API error'}) is explicit`, async () => {
    await start();
    slack.missingTs = missingTs;
    if (!missingTs) slack.failPost = new Error('API failure');
    expect((await slash('hello'))[0]).toContain('Could not start');
    expect(inbound).not.toHaveBeenCalled();
  });
}
test('markdown sends preserve threads and plain text fallback', async () => {
  await start();
  await plugin.send({ conversationId: 'C1:1', text: 'hello' });
  expect(slack.posts[0]).toMatchObject({
    channel: 'C1',
    thread_ts: '1',
    blocks: [{ type: 'markdown', text: 'hello' }],
  });
  slack.failPost = new Error('unsupported blocks');
  await plugin.send({ conversationId: 'C1', text: 'fallback' });
  expect(slack.posts[1]).toMatchObject({ channel: 'C1', text: 'fallback' });
  expect(slack.posts[1]).not.toHaveProperty('blocks');
});
test('long unbroken Unicode messages split within Slack limits without damaging content', async () => {
  const text = '🦊'.repeat(20000);
  expect(splitMessage(text).join('')).toBe(text);
  await start();
  await plugin.send({ conversationId: 'C1:1', text });
  expect(slack.posts.length).toBeGreaterThan(1);
  const reconstructed = slack.posts
    .map((post, index) => {
      const block = 'blocks' in post && Array.isArray(post.blocks) ? post.blocks[0] : undefined;
      if (
        !block ||
        block.type !== 'markdown' ||
        !('text' in block) ||
        typeof block.text !== 'string'
      )
        throw new Error('missing markdown');
      expect(block.text.length).toBeLessThanOrEqual(12000);
      const suffix = `\n\n_part ${index + 1}/${slack.posts.length}_`;
      expect(block.text.endsWith(suffix)).toBe(true);
      return block.text.slice(0, -suffix.length);
    })
    .join('');
  expect(reconstructed).toBe(text);
});
test('paragraph and line splits retain the complete content', () => {
  for (const text of ['a'.repeat(20000), 'paragraph\n\n'.repeat(5000), 'line\n'.repeat(5000)]) {
    expect(splitMessage(text).join('')).toBe(text);
    expect(splitMessage(text).every(chunk => chunk.length < 12000)).toBe(true);
  }
});
test('footers are informational and no-op without cost or usage', async () => {
  await start();
  await plugin.resultFooter({ conversationId: 'C1:1' });
  expect(slack.posts).toHaveLength(0);
  await plugin.resultFooter({
    conversationId: 'C1:1',
    cost: 0.02,
    tokens: { input: 1000, output: 2000 },
  });
  expect(slack.posts[0]).toMatchObject({
    channel: 'C1',
    thread_ts: '1',
    blocks: [{ type: 'context' }],
  });
  slack.failPost = new Error('footer failure');
  await plugin.resultFooter({ conversationId: 'C1:1', cost: 0.01 });
  expect(logs).toHaveBeenCalled();
});

test('trigger tracking caps distinct conversations and refreshing a thread does not evict another', async () => {
  await start();
  for (let i = 0; i < 1000; i++) await adapter.receive({ ...event, ts: String(i) });
  await adapter.receive({ ...event, ts: '999' });
  expect(adapter.getTriggeringMessage('C1:0')).toBeDefined();
  await adapter.receive({ ...event, ts: '1000' });
  expect(adapter.getTriggeringMessage('C1:0')).toBeUndefined();
  expect(adapter.getTriggeringMessage('C1:1')).toBeDefined();
  expect(adapter.getTriggeringMessage('C1:1000')).toBeDefined();
});

test('workflow registration and slash text follow the descriptor prefix', async () => {
  const original = descriptor.workflowCommand.prefix;
  descriptor.workflowCommand.prefix = '/test-workflow ';
  try {
    await start();
    expect([...slack.commands.keys()]).toEqual(['/archon', '/test-workflow']);
    expect((await slash('', '/test-workflow'))[0]).toBe(
      'Usage: `/test-workflow <subcommand>` — e.g. `list`, `status`, `get <id>`, `run <name> <args>`, `approve <id>`, `reject <id> <reason>`, `abandon <id>`.'
    );
    expect(await slash('run assist', '/test-workflow')).toEqual([
      'Running `/test-workflow run assist` — see thread for output.',
    ]);
    expect(slack.posts[0]).toMatchObject({ text: '<@U1> ran `/test-workflow run assist`' });
    expect(inbound.mock.calls[0]?.[0].text).toBe('/workflow run assist');
  } finally {
    descriptor.workflowCommand.prefix = original;
  }
});
