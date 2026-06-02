import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Create mock functions before mocking the module
const mockMessagesSend = mock(() => Promise.resolve());
const mockQueuesRegister = mock(() =>
  Promise.resolve({ queue_id: 'test-queue', last_event_id: 0 })
);
const mockEventsRetrieve = mock(() => Promise.resolve({ events: [] }));
const mockMessagesRetrieve = mock(
  (_params?: unknown): Promise<{ messages: unknown[] }> => Promise.resolve({ messages: [] })
);

const mockZulipClient = {
  queues: { register: mockQueuesRegister },
  events: { retrieve: mockEventsRetrieve },
  messages: { send: mockMessagesSend, retrieve: mockMessagesRetrieve },
};

const mockZulip = mock(() => Promise.resolve(mockZulipClient));

// Mock zulip-js — use { default: mockZulip } so the ESM default import resolves to mockZulip
mock.module('zulip-js', () => ({ default: mockZulip }));

// The adapter POSTs to the Zulip REST API via global fetch (register / send / flags).
// Stub it to a success response so tests make no network calls; include queue fields for register.
const mockFetch = mock((_url?: unknown, _init?: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify({ result: 'success', queue_id: 'q', last_event_id: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  )
);
globalThis.fetch = mockFetch as unknown as typeof fetch;

/** Flush queued microtasks/timers so background work (backfill, poll) can run in tests. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

import { ZulipAdapter, formatUtcTime } from './adapter';
import type { ZulipMessage, ZulipReplyContext } from './types';

describe('ZulipAdapter', () => {
  beforeEach(() => {
    mockMessagesSend.mockClear();
    mockQueuesRegister.mockClear();
    mockEventsRetrieve.mockClear();
    mockMessagesRetrieve.mockClear();
    mockMessagesRetrieve.mockImplementation(() => Promise.resolve({ messages: [] }));
    mockFetch.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  describe('streaming mode configuration', () => {
    test('should default to batch mode', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should accept explicit batch mode', () => {
      const adapter = new ZulipAdapter(
        'https://test.zulipchat.com',
        'bot@test.com',
        'key',
        'batch'
      );
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should accept explicit stream mode', () => {
      const adapter = new ZulipAdapter(
        'https://test.zulipchat.com',
        'bot@test.com',
        'key',
        'stream'
      );
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('platform type', () => {
    test('should return zulip as platform type', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      expect(adapter.getPlatformType()).toBe('zulip');
    });
  });

  describe('conversation ID extraction', () => {
    test('should produce stream conversation ID', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      const msg = {
        type: 'stream',
        stream_id: 99,
        subject: 'Topic Name',
        display_recipient: 'general',
      } as unknown as ZulipMessage;

      expect(adapter.getConversationId(msg)).toBe('stream:99:Topic Name');
    });

    test('should produce private conversation ID with sorted user IDs', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      const msg = {
        type: 'private',
        display_recipient: [
          { id: 22, email: 'b@test.com', full_name: 'B' },
          { id: 11, email: 'a@test.com', full_name: 'A' },
        ],
      } as unknown as ZulipMessage;

      expect(adapter.getConversationId(msg)).toBe('private:11:22');
    });

    test('should sort private recipient IDs ascending', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      const msg = {
        type: 'private',
        display_recipient: [
          { id: 300, email: 'c@test.com', full_name: 'C' },
          { id: 10, email: 'a@test.com', full_name: 'A' },
          { id: 50, email: 'b@test.com', full_name: 'B' },
        ],
      } as unknown as ZulipMessage;

      expect(adapter.getConversationId(msg)).toBe('private:10:50:300');
    });
  });

  describe('stripBotMention', () => {
    test('should remove @**Bot Name** mention', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      // Set botFullName via accessor (simulate after start())
      (adapter as unknown as { botFullName: string }).botFullName = 'Archon Bot';

      expect(adapter.stripBotMention('@**Archon Bot** help me')).toBe('help me');
    });

    test('should remove mention with no trailing space', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { botFullName: string }).botFullName = 'Archon Bot';

      expect(adapter.stripBotMention('@**Archon Bot**help me')).toBe('help me');
    });

    test('should remove multiple mentions', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { botFullName: string }).botFullName = 'Archon Bot';

      expect(adapter.stripBotMention('@**Archon Bot** hello @**Archon Bot** world')).toBe(
        'hello world'
      );
    });

    test('should return content unchanged when botFullName is empty', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      // botFullName defaults to ''
      expect(adapter.stripBotMention('@**Archon Bot** hello')).toBe('@**Archon Bot** hello');
    });
  });

  describe('ensureThread', () => {
    test('should return the same conversation ID (Zulip topics are already threads)', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      const result = await adapter.ensureThread('stream:99:My Topic');
      expect(result).toBe('stream:99:My Topic');
    });
  });

  describe('sendMessage', () => {
    test('should send a stream message via direct POST', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;

      // Set up reply context
      (adapter as unknown as { replyContexts: Map<string, ZulipReplyContext> }).replyContexts.set(
        'stream:99:Topic',
        { type: 'stream', stream_id: 99, topic: 'Topic' }
      );

      await adapter.sendMessage('stream:99:Topic', 'Hello from Archon');

      const call = mockFetch.mock.calls.find(c => String(c[0]).endsWith('/api/v1/messages'));
      expect(call).toBeDefined();
      const body = String((call![1] as { body?: unknown }).body);
      expect(body).toContain('type=stream');
      expect(body).toContain('to=99');
      expect(body).toContain('topic=Topic');
      expect(body).toContain('content=Hello');
    });

    test('should send a private message via direct POST (to = JSON id list)', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;

      (adapter as unknown as { replyContexts: Map<string, ZulipReplyContext> }).replyContexts.set(
        'private:11:22',
        { type: 'private', user_ids: [11, 22] }
      );

      await adapter.sendMessage('private:11:22', 'Hello privately');

      const call = mockFetch.mock.calls.find(c => String(c[0]).endsWith('/api/v1/messages'));
      expect(call).toBeDefined();
      const body = decodeURIComponent(String((call![1] as { body?: unknown }).body));
      expect(body).toContain('type=private');
      expect(body).toContain('to=[11,22]');
    });

    test('should split messages longer than 9800 chars into multiple POSTs', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;

      (adapter as unknown as { replyContexts: Map<string, ZulipReplyContext> }).replyContexts.set(
        'stream:1:T',
        { type: 'stream', stream_id: 1, topic: 'T' }
      );

      const para1 = 'a'.repeat(5000);
      const para2 = 'b'.repeat(5000);
      const longMessage = `${para1}\n\n${para2}`;

      await adapter.sendMessage('stream:1:T', longMessage);

      const msgCalls = mockFetch.mock.calls.filter(c => String(c[0]).endsWith('/api/v1/messages'));
      expect(msgCalls.length).toBeGreaterThan(1);
    });

    test('should log error and return when no reply context is found', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;

      await adapter.sendMessage('stream:99:Unknown', 'Hello');

      expect(mockLogger.error).toHaveBeenCalled();
      // sendMessage posts via fetch (zulipPost), not client.messages.send — assert the real
      // transport made no message POST, so a stray send can't slip past a vacuous assertion.
      const msgCalls = mockFetch.mock.calls.filter(c => String(c[0]).endsWith('/api/v1/messages'));
      expect(msgCalls.length).toBe(0);
    });
  });

  describe('lifecycle', () => {
    test('should set running to false on stop', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      adapter.stop();
      expect((adapter as unknown as { running: boolean }).running).toBe(false);
    });

    test('start() returns promptly while poll loop runs in background', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');

      // Block events.retrieve so start() would hang forever if it awaits the poll loop
      mockEventsRetrieve.mockImplementation(() => new Promise(() => {}));

      const result = await Promise.race([
        (async () => {
          await adapter.start();
          return 'started' as const;
        })(),
        new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 500)),
      ]);

      expect(result).toBe('started');
      expect((adapter as unknown as { running: boolean }).running).toBe(true);

      adapter.stop();
      expect((adapter as unknown as { running: boolean }).running).toBe(false);
    });
  });

  describe('message handler registration', () => {
    test('should allow registering a message handler', () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      const handler = mock(() => Promise.resolve(undefined));
      adapter.onMessage(handler);
      expect((adapter as unknown as { messageHandler: unknown }).messageHandler).toBe(handler);
    });
  });

  describe('startup backfill (catch up on missed messages)', () => {
    const dm = (id: number): ZulipMessage => ({
      id,
      sender_id: 6,
      sender_email: 'v@test.com',
      sender_full_name: 'V',
      content: 'ping',
      type: 'private',
      display_recipient: [{ id: 6, email: 'v@test.com', full_name: 'V' }],
    });
    const mention = (id: number): ZulipMessage => ({
      id,
      sender_id: 5,
      sender_email: 'u@test.com',
      sender_full_name: 'U',
      content: '@**TestBot** hi',
      type: 'stream',
      stream_id: 1,
      subject: 'topic',
      display_recipient: 'general',
    });
    // narrow-aware retrieve: return mentions for is:mentioned, dms for is:private
    const retrieveReturning = (mentions: ZulipMessage[], dms: ZulipMessage[]) =>
      mockMessagesRetrieve.mockImplementation(params => {
        // mock declares the param as unknown; the adapter always passes a narrow array
        const narrow = (params as { narrow: { operand: string }[] }).narrow;
        const isMention = narrow.some(n => n.operand === 'mentioned');
        return Promise.resolve({ messages: isMention ? mentions : dms });
      });

    test('registers the queue (direct POST) with apply_markdown=false for raw-markdown mentions', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      mockEventsRetrieve.mockImplementation(() => new Promise(() => {})); // block live loop
      await adapter.start();
      const reg = mockFetch.mock.calls.find(c => String(c[0]).endsWith('/api/v1/register'));
      expect(reg).toBeDefined();
      const body = String((reg![1] as { body?: unknown }).body);
      expect(body).toContain('apply_markdown=false');
      // subscribes to message + update_message (so edit-to-add-mention is delivered)
      expect(decodeURIComponent(body)).toContain('update_message');
      adapter.stop();
    });

    test('aborts the backfill cycle (does not process any messages) when the unread fetch fails', async () => {
      // Wirasm review: `fetchUnread` returning [] on failure silently erased missed messages.
      // After the fix it returns undefined and `backfillUnansweredMessages` bails — messages stay
      // unread in Zulip for the next restart to retry. This test guards that contract.
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        const handled: number[] = [];
        adapter.onMessage(m => {
          handled.push(m.id);
          return Promise.resolve();
        });
        mockEventsRetrieve.mockImplementation(() => new Promise(() => {})); // block live loop
        mockMessagesRetrieve.mockImplementation(() =>
          Promise.reject(new Error('zulip 503 backfill fail'))
        );

        await adapter.start();
        await flush();
        await flush();

        expect(handled).toEqual([]); // no messages processed
        const abortedLog = mockLogger.error.mock.calls.find(
          args => args[args.length - 1] === 'zulip.backfill_aborted'
        );
        expect(abortedLog).toBeDefined();
        const flagsCalls = mockFetch.mock.calls.filter(c =>
          String(c[0]).endsWith('/api/v1/messages/flags')
        );
        expect(flagsCalls.length).toBe(0); // no spurious mark-read on a failed cycle
        adapter.stop();
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('answers unread mentions and DMs oldest-first; defers mark-read until a reply', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        const handled: number[] = [];
        adapter.onMessage(m => {
          handled.push(m.id);
          return Promise.resolve(); // handler does not post a reply
        });
        mockEventsRetrieve.mockImplementation(() => new Promise(() => {})); // block live loop
        retrieveReturning([mention(10)], [dm(7)]);

        await adapter.start();
        await flush();
        await flush();

        expect(handled).toEqual([7, 10]); // sorted by id ascending
        // No reply was posted, so nothing is marked read yet — it stays unread for retry.
        const flagsCalls = mockFetch.mock.calls.filter(c =>
          String(c[0]).endsWith('/api/v1/messages/flags')
        );
        expect(flagsCalls.length).toBe(0);
        adapter.stop();
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('marks an incoming message read only after a reply is posted', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        // Incoming stream mention (id 10, stream_id 1, topic 'topic') -> conversationId stream:1:topic
        await (
          adapter as unknown as { handleIncomingMessage: (m: ZulipMessage) => Promise<void> }
        ).handleIncomingMessage(mention(10));

        // Not marked read yet — no reply has been posted.
        expect(
          mockFetch.mock.calls.filter(c => String(c[0]).endsWith('/api/v1/messages/flags')).length
        ).toBe(0);

        // Posting a reply to that conversation marks the queued id read.
        await adapter.sendMessage('stream:1:topic', 'hi back');

        const flags = mockFetch.mock.calls.filter(c =>
          String(c[0]).endsWith('/api/v1/messages/flags')
        );
        expect(flags.length).toBe(1);
        expect(decodeURIComponent(String((flags[0]![1] as { body?: unknown }).body))).toContain(
          'messages=[10]'
        );
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('does not answer a message delivered by both backfill and the live queue', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        const handled: number[] = [];
        adapter.onMessage(m => {
          handled.push(m.id);
          return Promise.resolve();
        });
        retrieveReturning([], [dm(42)]);
        // Live queue delivers the SAME message once, then blocks.
        let delivered = false;
        mockEventsRetrieve.mockImplementation(() => {
          if (delivered) return new Promise(() => {});
          delivered = true;
          return Promise.resolve({ events: [{ type: 'message', id: 1, message: dm(42) }] });
        });

        await adapter.start();
        await flush();
        await flush();
        await flush();

        expect(handled).toEqual([42]); // handled exactly once
        adapter.stop();
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });
  });

  describe('edited messages (edit-to-add-mention)', () => {
    const edited = (id: number, content: string): ZulipMessage => ({
      id,
      sender_id: 5,
      sender_email: 'u@test.com',
      sender_full_name: 'U',
      content,
      type: 'stream',
      stream_id: 1,
      subject: 'topic',
      display_recipient: 'general',
    });
    const callEdit = (a: ZulipAdapter, id: number): Promise<void> =>
      (a as unknown as { handleEditedMessage: (i: number) => Promise<void> }).handleEditedMessage(
        id
      );

    test('answers a message edited to add a mention', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        const handled: number[] = [];
        adapter.onMessage(m => {
          handled.push(m.id);
          return Promise.resolve();
        });
        mockMessagesRetrieve.mockImplementation(() =>
          Promise.resolve({ messages: [edited(55, '@**TestBot** now mentioned')] })
        );

        await callEdit(adapter, 55);

        expect(handled).toEqual([55]);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('ignores an edit that still has no mention', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        const handled: number[] = [];
        adapter.onMessage(m => {
          handled.push(m.id);
          return Promise.resolve();
        });
        mockMessagesRetrieve.mockImplementation(() =>
          Promise.resolve({ messages: [edited(56, 'still no mention')] })
        );

        await callEdit(adapter, 56);

        expect(handled).toEqual([]);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('does not re-fetch/re-handle an edit for an already-answered message', async () => {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
      (adapter as unknown as { processedMessageIds: Set<number> }).processedMessageIds.add(77);
      mockMessagesRetrieve.mockClear();

      await callEdit(adapter, 77);

      expect(mockMessagesRetrieve).not.toHaveBeenCalled(); // dedup short-circuits before fetch
    });
  });

  describe('status messages', () => {
    const streamMention = (): ZulipMessage => ({
      id: 100,
      sender_id: 5,
      sender_email: 'u@test.com',
      sender_full_name: 'U',
      content: '@**TestBot** hello',
      type: 'stream',
      stream_id: 1,
      subject: 'topic',
      display_recipient: 'general',
    });
    const dm = (): ZulipMessage => ({
      id: 101,
      sender_id: 6,
      sender_email: 'v@test.com',
      sender_full_name: 'V',
      content: 'ping',
      type: 'private',
      display_recipient: [{ id: 6, email: 'v@test.com', full_name: 'V' }],
    });

    const callHandle = (a: ZulipAdapter, msg: ZulipMessage): Promise<void> =>
      (
        a as unknown as { handleIncomingMessage: (m: ZulipMessage) => Promise<void> }
      ).handleIncomingMessage(msg);

    // Reset fetch mock to return a distinct id for status messages
    const setupFetchWithId = (statusId: number): void => {
      mockFetch.mockImplementation((_url?: unknown, _init?: unknown) =>
        Promise.resolve(
          new Response(
            JSON.stringify({ result: 'success', id: statusId, queue_id: 'q', last_event_id: 0 }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        )
      );
    };

    test('creates status message on stream mention, captures message_id', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        setupFetchWithId(42);
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        await callHandle(adapter, streamMention());

        const queues = (
          adapter as unknown as {
            statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
          }
        ).statusMessageQueues;
        const conv = 'stream:1:topic';
        expect(queues.has(conv)).toBe(true);
        expect(queues.get(conv)![0]!.id).toBe(42);
        expect(queues.get(conv)![0]!.text).toMatch(/Starting thinking\.\.\./);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('creates status message on DM', async () => {
      setupFetchWithId(99);
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
      adapter.onMessage(() => Promise.resolve());

      await callHandle(adapter, dm());

      const queues = (
        adapter as unknown as {
          statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
        }
      ).statusMessageQueues;
      const conv = 'private:6';
      expect(queues.has(conv)).toBe(true);
      expect(queues.get(conv)![0]!.id).toBe(99);
    });

    test('status message has no header — only timestamped lines', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        setupFetchWithId(55);
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());
        mockFetch.mockClear();

        await callHandle(adapter, streamMention());

        const statusCall = mockFetch.mock.calls.find(c =>
          String((c[1] as { body?: unknown }).body).includes('Starting+thinking')
        );
        expect(statusCall).toBeDefined();
        const rawBody = String((statusCall![1] as { body?: unknown }).body);
        const content = new URLSearchParams(rawBody).get('content') ?? '';
        // Must NOT contain a title/header before the timestamp line
        expect(content).not.toMatch(/^#/);
        expect(content).toMatch(/\d{2}:\d{2}:\d{2} Starting thinking\.\.\./);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('on success: status edited with "Done thinking." then answer posted separately', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        // Phase 1: handle incoming — status message created with id=77
        setupFetchWithId(77);
        await callHandle(adapter, streamMention());
        mockFetch.mockClear();

        // Phase 2: answer arrives
        setupFetchWithId(0); // id doesn't matter for the answer POST
        await adapter.sendMessage('stream:1:topic', 'The answer');

        const calls = mockFetch.mock.calls;
        // First call should be PATCH to update status (messages/77)
        const patchCall = calls.find(
          c =>
            String(c[0]).includes('/messages/77') &&
            (c[1] as { method?: string }).method === 'PATCH'
        );
        expect(patchCall).toBeDefined();
        const patchBody =
          new URLSearchParams(String((patchCall![1] as { body?: unknown }).body)).get('content') ??
          '';
        expect(patchBody).toContain('Done thinking.');
        expect(patchBody).not.toContain('FAILED');

        // Second call should be POST of the actual answer
        const answerCall = calls.find(
          c =>
            String(c[0]).endsWith('/api/v1/messages') &&
            (c[1] as { method?: string }).method === 'POST' &&
            String((c[1] as { body?: unknown }).body).includes('The+answer')
        );
        expect(answerCall).toBeDefined();

        // Status message queue must be cleared after the answer
        const queues = (
          adapter as unknown as {
            statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
          }
        ).statusMessageQueues;
        expect(queues.has('stream:1:topic')).toBe(false);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('on failure: status edited with "Done thinking (FAILED)." and error posted in place of answer', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        setupFetchWithId(88);
        await callHandle(adapter, streamMention());
        mockFetch.mockClear();
        setupFetchWithId(0);

        await adapter.sendMessage('stream:1:topic', 'Something went wrong', { isError: true });

        const calls = mockFetch.mock.calls;
        const patchCall = calls.find(
          c =>
            String(c[0]).includes('/messages/88') &&
            (c[1] as { method?: string }).method === 'PATCH'
        );
        expect(patchCall).toBeDefined();
        const patchBody =
          new URLSearchParams(String((patchCall![1] as { body?: unknown }).body)).get('content') ??
          '';
        expect(patchBody).toContain('Done thinking (FAILED).');

        const errorCall = calls.find(
          c =>
            String(c[0]).endsWith('/api/v1/messages') &&
            (c[1] as { method?: string }).method === 'POST' &&
            String((c[1] as { body?: unknown }).body).includes('went+wrong')
        );
        expect(errorCall).toBeDefined();
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('concurrent mentions in different conversations get independent status messages', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        let nextId = 200;
        mockFetch.mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ result: 'success', id: nextId++, queue_id: 'q', last_event_id: 0 }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        );
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        const msgConv1: ZulipMessage = {
          ...streamMention(),
          id: 1,
          stream_id: 1,
          subject: 'topic-a',
        };
        const msgConv2: ZulipMessage = {
          ...streamMention(),
          id: 2,
          stream_id: 2,
          subject: 'topic-b',
        };

        await callHandle(adapter, msgConv1);
        await callHandle(adapter, msgConv2);

        const queues = (
          adapter as unknown as {
            statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
          }
        ).statusMessageQueues;
        expect(queues.get('stream:1:topic-a')![0]!.id).not.toBe(
          queues.get('stream:2:topic-b')![0]!.id
        );
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });

    test('FIFO: two mentions for same conversation get separate status messages in order', async () => {
      process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
      try {
        let nextId = 300;
        mockFetch.mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ result: 'success', id: nextId++, queue_id: 'q', last_event_id: 0 }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
          )
        );
        const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
        (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
        adapter.onMessage(() => Promise.resolve());

        const msg1: ZulipMessage = { ...streamMention(), id: 10 };
        const msg2: ZulipMessage = { ...streamMention(), id: 11 };

        await callHandle(adapter, msg1); // creates status id=300
        await callHandle(adapter, msg2); // creates status id=301 (but id=10 is already processed)

        const queues = (
          adapter as unknown as {
            statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
          }
        ).statusMessageQueues;
        // msg2 is ignored by processedMessageIds (id=11 not yet processed) but msg1 is deduped
        // The important thing: at most 1 entry queued per unique message
        const q = queues.get('stream:1:topic') ?? [];
        expect(q.length).toBe(2);
        expect(q[0]!.id).toBe(300);
        expect(q[1]!.id).toBe(301);
      } finally {
        delete process.env.ZULIP_BOT_FULL_NAME;
      }
    });
  });
});

// Coverage for the gaps Wirasm flagged on PR #1760:
// formatUtcTime isolate, zulipPost error branch, FIFO eviction, debounce guard,
// plus the backfill "no abort on successful empty fetch" negative assertion.

describe('formatUtcTime', () => {
  test('returns time in HH:MM:SS format with zero-padded components', () => {
    expect(formatUtcTime()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('uses UTC accessors (independent of local timezone)', () => {
    // Verify the formatted seconds match Date.getUTCSeconds() at call-time, allowing for the
    // one-second window where the clock could have ticked between samples.
    const before = new Date().getUTCSeconds();
    const result = formatUtcTime();
    const after = new Date().getUTCSeconds();
    const parsedSec = Number(result.split(':')[2]);
    expect([before, after, (before + 1) % 60]).toContain(parsedSec);
  });
});

describe('zulipPost error branch', () => {
  test('throws when the HTTP response has a non-2xx status', async () => {
    const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: 'error', msg: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    await expect(adapter.start()).rejects.toThrow(/Zulip POST \/register failed: HTTP 401/);
  });

  test('throws when the response is 200 but result is not "success"', async () => {
    const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: 'error', msg: 'bad request' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    await expect(adapter.start()).rejects.toThrow(/Zulip POST \/register failed:.*bad request/);
  });
});

describe('FIFO eviction', () => {
  // The constants live in adapter.ts and are not exported (REPLY_CONTEXTS_MAX=1000,
  // PROCESSED_IDS_MAX=2000). Tests assert the invariant — the cap holds and the oldest
  // entry is the one dropped — rather than the specific numeric value.
  test('evicts the oldest replyContexts entry once REPLY_CONTEXTS_MAX is reached', async () => {
    process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
    try {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
      const ctxs = (adapter as unknown as { replyContexts: Map<string, ZulipReplyContext> })
        .replyContexts;

      // Saturate the map up to (just under) the eviction threshold by directly populating it —
      // dispatching that many messages through the public API would be unnecessarily slow.
      for (let i = 0; i < 1000; i++) {
        ctxs.set(`stream:${i}:T`, { type: 'stream', stream_id: i, topic: 'T' });
      }
      const capacity = ctxs.size;
      expect(ctxs.has('stream:0:T')).toBe(true);

      // One more inbound message creates a new context, which must evict the oldest.
      await (
        adapter as unknown as { handleIncomingMessage: (m: ZulipMessage) => Promise<void> }
      ).handleIncomingMessage({
        id: 99999,
        sender_id: 5,
        sender_email: 'u@test.com',
        sender_full_name: 'U',
        content: '@**TestBot** hi',
        type: 'stream',
        stream_id: 9999,
        subject: 'new',
        display_recipient: 'general',
      });

      expect(ctxs.size).toBe(capacity); // capped, not grown
      expect(ctxs.has('stream:0:T')).toBe(false); // oldest gone
      expect(ctxs.has('stream:9999:new')).toBe(true); // new added
    } finally {
      delete process.env.ZULIP_BOT_FULL_NAME;
    }
  });

  test('evicts the oldest processedMessageIds entry once PROCESSED_IDS_MAX is reached', () => {
    const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
    const processed = (adapter as unknown as { processedMessageIds: Set<number> })
      .processedMessageIds;

    for (let i = 1; i <= 2000; i++) processed.add(i);
    const capacity = processed.size;
    expect(processed.has(1)).toBe(true);

    (adapter as unknown as { rememberProcessed: (n: number) => void }).rememberProcessed(99999);

    expect(processed.size).toBe(capacity); // capped, not grown
    expect(processed.has(1)).toBe(false); // oldest gone (Set iteration = insertion order)
    expect(processed.has(99999)).toBe(true);
  });
});

describe('status-message debounce guard', () => {
  test('skips the status-message edit (and logs) when more entries remain and lastEdit is recent', async () => {
    const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
    (adapter as unknown as { client: typeof mockZulipClient }).client = mockZulipClient;
    (adapter as unknown as { replyContexts: Map<string, ZulipReplyContext> }).replyContexts.set(
      'stream:1:T',
      { type: 'stream', stream_id: 1, topic: 'T' }
    );
    // Two queued status entries so the drain leaves the queue non-empty (debounce only fires
    // while more entries remain — once empty, the final update always goes through).
    // lastEdit set to "now" means now - lastEdit ~= 0, well under STATUS_MIN_INTERVAL_MS (500ms).
    (
      adapter as unknown as {
        statusMessageQueues: Map<string, Array<{ id: number; text: string }>>;
      }
    ).statusMessageQueues.set('stream:1:T', [
      { id: 100, text: 'Starting thinking...' },
      { id: 101, text: 'Starting thinking...' },
    ]);
    (adapter as unknown as { statusLastEdit: Map<string, number> }).statusLastEdit.set(
      'stream:1:T',
      Date.now()
    );

    mockFetch.mockClear();
    mockLogger.warn.mockClear();

    await adapter.sendMessage('stream:1:T', 'answer');

    // No PATCH to /api/v1/messages/<id> (the status-edit endpoint) means the edit was skipped.
    const patchEdits = mockFetch.mock.calls.filter(c => {
      const url = String(c[0]);
      const init = c[1] as { method?: string } | undefined;
      return /\/api\/v1\/messages\/\d+$/.test(url) && init?.method === 'PATCH';
    });
    expect(patchEdits.length).toBe(0);

    const skipped = mockLogger.warn.mock.calls.find(
      args => args[args.length - 1] === 'zulip.status_debounce_skipped'
    );
    expect(skipped).toBeDefined();
  });
});

// Negative assertion for the backfill_aborted contract (Wirasm 2nd review): confirm the abort
// path is taken ONLY on actual fetch failures — a successful fetch that returns zero unread
// messages must NOT log `zulip.backfill_aborted`. Without this companion to the failure test
// above, we couldn't distinguish "abort because of failure" from "abort regardless".
describe('startup backfill — empty success does not trip abort', () => {
  test('a clean fetch that returns no unread messages completes without backfill_aborted', async () => {
    process.env.ZULIP_BOT_FULL_NAME = 'TestBot';
    try {
      const adapter = new ZulipAdapter('https://test.zulipchat.com', 'bot@test.com', 'key');
      mockEventsRetrieve.mockImplementation(() => new Promise(() => {})); // block live loop
      mockMessagesRetrieve.mockImplementation(() => Promise.resolve({ messages: [] }));

      await adapter.start();
      await flush();
      await flush();

      const aborted = mockLogger.error.mock.calls.find(
        args => args[args.length - 1] === 'zulip.backfill_aborted'
      );
      expect(aborted).toBeUndefined(); // success-but-empty must NOT take the abort path
      const none = mockLogger.info.mock.calls.find(
        args => args[args.length - 1] === 'zulip.backfill_none'
      );
      expect(none).toBeDefined();
      adapter.stop();
    } finally {
      delete process.env.ZULIP_BOT_FULL_NAME;
    }
  });
});
