import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { buildConversationId, parseConversationId, sendComment } from './comment-delivery';
import * as log from './log';

const silentLog = { debug: mock(), info: mock(), warn: mock(), error: mock() };
let getLogSpy: ReturnType<typeof spyOn<typeof log, 'getLog'>>;

type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
const originalFetch = globalThis.fetch;
const mockFetch = Object.assign(mock<FetchCall>(), {
  preconnect: mock<typeof fetch.preconnect>(() => undefined),
}) satisfies Mock<FetchCall> & Pick<typeof fetch, 'preconnect'>;

beforeAll(() => {
  getLogSpy = spyOn(log, 'getLog').mockReturnValue(
    silentLog as unknown as ReturnType<typeof log.getLog>
  );
  globalThis.fetch = mockFetch;
});
afterAll(() => {
  getLogSpy.mockRestore();
  globalThis.fetch = originalFetch;
});

const client = { gitlabUrl: 'https://gitlab.example.com', token: 'test-token' };

describe('conversation ID parsing', () => {
  test('parses issue conversation ID (# separator)', () => {
    expect(parseConversationId('mygroup/myproject#42')).toEqual({
      projectPath: 'mygroup/myproject',
      iid: 42,
      isMR: false,
    });
  });

  test('parses MR conversation ID (! separator)', () => {
    expect(parseConversationId('mygroup/myproject!15')).toEqual({
      projectPath: 'mygroup/myproject',
      iid: 15,
      isMR: true,
    });
  });

  test('parses nested group conversation ID', () => {
    expect(parseConversationId('org/team/subteam/project#7')).toEqual({
      projectPath: 'org/team/subteam/project',
      iid: 7,
      isMR: false,
    });
  });

  test('returns null for invalid conversation ID', () => {
    expect(parseConversationId('invalid')).toBeNull();
  });

  test('builds correct conversation IDs', () => {
    expect(buildConversationId('group/project', 42, false)).toBe('group/project#42');
    expect(buildConversationId('group/project', 15, true)).toBe('group/project!15');
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
  });

  test('posts to correct issue notes API endpoint', async () => {
    await sendComment(client, 'mygroup/myproject#42', 'Hello from Archon');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyproject/issues/42/notes'
    );
    expect(options.method).toBe('POST');
  });

  test('posts to correct MR notes API endpoint', async () => {
    await sendComment(client, 'mygroup/myproject!15', 'Review complete');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gitlab.example.com/api/v4/projects/mygroup%2Fmyproject/merge_requests/15/notes'
    );
  });

  test('appends bot response marker to outgoing comments', async () => {
    await sendComment(client, 'mygroup/myproject#1', 'Test message');

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { body: string };
    expect(body.body).toContain('Test message');
    expect(body.body).toContain('<!-- archon-bot-response -->');
    expect(body.body).toBe('Test message\n\n<!-- archon-bot-response -->');
  });

  test('encodes nested project path in URL', async () => {
    await sendComment(client, 'org/team/subproject#7', 'Nested group test');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('org%2Fteam%2Fsubproject');
  });

  test('rejects invalid conversation ID without calling API', async () => {
    await sendComment(client, 'invalid-format', 'Should not send');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(silentLog.error).toHaveBeenCalledWith(
      { conversationId: 'invalid-format' },
      'gitlab.invalid_conversation_id'
    );
  });

  test('splits long messages into multiple API calls', async () => {
    // Build a message with paragraph breaks that exceeds MAX_LENGTH (65000)
    // Each paragraph is ~1000 chars, 80 paragraphs = ~80k + separators
    const paragraphs = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${String(i)}: ${'x'.repeat(990)}`
    );
    const longMessage = paragraphs.join('\n\n');
    await sendComment(client, 'mygroup/myproject#1', longMessage);

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });
});
