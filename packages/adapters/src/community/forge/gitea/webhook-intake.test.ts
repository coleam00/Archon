import {
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { Mock } from 'bun:test';
import {
  buildCommentMessage,
  fetchCommentHistory,
  hasMention,
  stripMention,
} from './webhook-intake';
import * as log from './log';

// Failure paths log at error level; keep them out of the test output.
const silentLog = { debug: mock(), info: mock(), warn: mock(), error: mock() };
let getLogSpy: ReturnType<typeof spyOn<typeof log, 'getLog'>>;
beforeAll(() => {
  getLogSpy = spyOn(log, 'getLog').mockReturnValue(
    silentLog as unknown as ReturnType<typeof log.getLog>
  );
});
afterAll(() => {
  getLogSpy.mockRestore();
});

type FetchCall = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
type FetchMock = Mock<FetchCall> & Pick<typeof fetch, 'preconnect'>;

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), init);
}

async function copyResponse(response: Response): Promise<Response> {
  const body = await response.clone().arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
  });
}

function makeFetchMock(response: Response = jsonResponse({}, { status: 200 })): FetchMock {
  return Object.assign(
    mock<FetchCall>(() => copyResponse(response)),
    {
      preconnect: mock<typeof fetch.preconnect>(() => undefined),
    }
  );
}

const client = { baseUrl: 'https://gitea.example.com', token: 'fake-token-for-testing' };

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('bot mention detection', () => {
  test('should detect mention case-insensitively', () => {
    expect(hasMention('@Dylan please help', 'Dylan')).toBe(true);
    expect(hasMention('@dylan please help', 'Dylan')).toBe(true);
    expect(hasMention('@DYLAN please help', 'Dylan')).toBe(true);
    expect(hasMention('@DyLaN please help', 'Dylan')).toBe(true);

    expect(hasMention('@other-bot please help', 'Dylan')).toBe(false);
    expect(hasMention('no mention here', 'Dylan')).toBe(false);
  });

  test('should detect mention when it is the entire message', () => {
    expect(hasMention('@Archon', 'Archon')).toBe(true);
    expect(hasMention('@ARCHON', 'Archon')).toBe(true);
    expect(hasMention('@archon', 'Archon')).toBe(true);
  });

  test('should strip mention case-insensitively', () => {
    expect(stripMention('@Dylan please help', 'Dylan')).toBe('please help');
    expect(stripMention('@dylan please help', 'Dylan')).toBe('please help');
    expect(stripMention('@DYLAN please help', 'Dylan')).toBe('please help');
  });
});

describe('fetchCommentHistory', () => {
  test('should fetch and format comment history', async () => {
    const mockFetch = makeFetchMock(
      jsonResponse([
        { user: { login: 'user1' }, body: 'First comment' },
        { user: { login: 'user2' }, body: 'Second comment' },
        { user: { login: 'user3' }, body: 'Third comment' },
      ])
    );
    globalThis.fetch = mockFetch;

    const history = await fetchCommentHistory(client, 'owner', 'repo', 123);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitea.example.com/api/v1/repos/owner/repo/issues/123/comments',
      expect.objectContaining({
        headers: { Authorization: 'token fake-token-for-testing' },
      })
    );

    expect(history).toEqual([
      'user1: First comment',
      'user2: Second comment',
      'user3: Third comment',
    ]);
  });

  test('should return empty array on API error', async () => {
    const mockFetch = makeFetchMock(
      new Response(null, { status: 429, statusText: 'Too Many Requests' })
    );
    globalThis.fetch = mockFetch;

    const history = await fetchCommentHistory(client, 'owner', 'repo', 123);
    expect(history).toEqual([]);
  });

  test('should only return last 20 comments', async () => {
    const manyComments = Array.from({ length: 30 }, (_, i) => ({
      user: { login: `user${String(i + 1)}` },
      body: `Comment ${String(i + 1)}`,
    }));
    const mockFetch = makeFetchMock(jsonResponse(manyComments));
    globalThis.fetch = mockFetch;

    const history = await fetchCommentHistory(client, 'owner', 'repo', 123);

    expect(history).toHaveLength(20);
    expect(history[0]).toBe('user11: Comment 11');
    expect(history[19]).toBe('user30: Comment 30');
  });
});

describe('tea CLI context hints', () => {
  test('should include tea CLI hint in issue context', () => {
    const issue = {
      number: 42,
      title: 'Test Issue',
      body: 'Issue description',
      user: { login: 'testuser' },
      labels: [{ name: 'bug' }],
      state: 'open',
    };

    const { message } = buildCommentMessage('fix this please', false, issue, undefined);

    expect(message).toContain('tea issue view 42');
    expect(message).not.toContain('gh issue');
  });

  test('should include tea CLI hint in PR context', () => {
    const pr = {
      number: 99,
      title: 'My PR',
      body: 'PR description',
      user: { login: 'testuser' },
      state: 'open',
      changed_files: 3,
      additions: 10,
      deletions: 2,
    };

    const { message } = buildCommentMessage('review this please', true, undefined, pr);

    expect(message).toContain('tea pr view 99');
    expect(message).not.toContain('gh pr');
  });
});
