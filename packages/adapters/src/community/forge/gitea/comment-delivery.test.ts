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
import { buildConversationId, parseConversationId, sendComment } from './comment-delivery';
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

function postedBody(fetchMock: FetchMock, index: number): string {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error(`fetch call ${String(index)} has no string body`);
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('body' in parsed) ||
    typeof parsed.body !== 'string'
  ) {
    throw new Error(`fetch call ${String(index)} has no JSON body field`);
  }
  return parsed.body;
}

const client = { baseUrl: 'https://gitea.example.com', token: 'fake-token-for-testing' };

function send(conversationId: string, message: string): Promise<void> {
  return sendComment(client, conversationId, message, () => 1);
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('conversationId format', () => {
  test('should parse valid owner/repo#number format for issues', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    await send('owner/repo#123', 'test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe(
      'https://gitea.example.com/api/v1/repos/owner/repo/issues/123/comments'
    );
    expect(callArgs[1]?.method).toBe('POST');
    expect(new Headers(callArgs[1]?.headers).get('Authorization')).toBe(
      'token fake-token-for-testing'
    );
  });

  test('should parse valid owner/repo!number format for PRs', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    await send('owner/repo!456', 'test');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    // Gitea uses issues endpoint for PR comments too
    expect(callArgs[0]).toBe(
      'https://gitea.example.com/api/v1/repos/owner/repo/issues/456/comments'
    );
  });

  test('postComment appends bot marker to outgoing comments', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    await send('owner/repo#123', 'Hello world');

    const body = postedBody(mockFetch, 0);
    expect(body).toContain('Hello world');
    expect(body).toContain('<!-- archon-bot-response -->');
    expect(body).toBe('Hello world\n\n<!-- archon-bot-response -->');
  });

  test('should reject invalid conversationId format', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    // Invalid format should return early without calling API
    await send('owner/repo#pr-42', 'test');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('message splitting', () => {
  test('should split long messages into multiple chunks', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    // Create message exceeding MAX_LENGTH (65000)
    const paragraph1 = 'a'.repeat(40000);
    const paragraph2 = 'b'.repeat(30000);
    const message = `${paragraph1}\n\n${paragraph2}`;

    await send('owner/repo#123', message);

    // Should have sent 2 separate comments
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First chunk should contain paragraph1
    const firstBody = postedBody(mockFetch, 0);
    expect(firstBody).toContain('aaa');

    // Second chunk should contain paragraph2
    const secondBody = postedBody(mockFetch, 1);
    expect(secondBody).toContain('bbb');

    // Verify chunk sizes are within limits
    expect(firstBody.length).toBeLessThanOrEqual(65000);
    expect(secondBody.length).toBeLessThanOrEqual(65000);
  });

  test('should not split message at exactly MAX_LENGTH', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    // Message exactly at MAX_LENGTH (65000) should not be split
    const message = 'a'.repeat(65000);
    await send('owner/repo#123', message);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('should handle message without paragraph breaks', async () => {
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    // Message under MAX_LENGTH with no paragraph breaks
    const message = 'a'.repeat(50000);
    await send('owner/repo#123', message);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('should throw error when chunk posting fails', async () => {
    const mockFetch = makeFetchMock()
      .mockResolvedValueOnce(new Response(null, { status: 200 })) // First chunk succeeds
      .mockResolvedValueOnce(
        new Response('Rate limit exceeded', { status: 429, statusText: 'Too Many Requests' })
      ); // Second chunk fails
    globalThis.fetch = mockFetch;

    // Create message that will be split into 2 chunks
    const paragraph1 = 'a'.repeat(40000);
    const paragraph2 = 'b'.repeat(30000);
    const message = `${paragraph1}\n\n${paragraph2}`;

    // Should throw with context about partial delivery
    await expect(send('owner/repo#123', message)).rejects.toThrow(
      /Failed to post comment chunk 2\/2/
    );

    // First chunk should have been posted
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('retry logic', () => {
  test('should retry on transient network errors', async () => {
    const mockFetch = makeFetchMock()
      .mockRejectedValueOnce(new Error('fetch failed')) // First attempt fails
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // Second attempt succeeds
    globalThis.fetch = mockFetch;

    await send('owner/repo#123', 'test message');

    // Should have retried once
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('should not retry on non-retryable errors', async () => {
    const mockFetch = makeFetchMock(
      new Response('Bad credentials', { status: 401, statusText: 'Unauthorized' })
    );
    globalThis.fetch = mockFetch;

    // Should throw immediately without retry
    await expect(send('owner/repo#123', 'test message')).rejects.toThrow(
      'Gitea API error: 401 Unauthorized'
    );

    // Should only have tried once (no retry for auth errors)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('should throw after exhausting retries', async () => {
    const mockFetch = makeFetchMock().mockRejectedValue(new Error('fetch failed'));
    globalThis.fetch = mockFetch;

    await expect(send('owner/repo#123', 'test message')).rejects.toThrow('fetch failed');

    // Should have tried 3 times (max retries)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('issue vs PR conversation ID format', () => {
  test('should build issue conversation ID with #', () => {
    const id = buildConversationId('owner', 'repo', 42, false);
    expect(id).toBe('owner/repo#42');
  });

  test('should build PR conversation ID with !', () => {
    const id = buildConversationId('owner', 'repo', 42, true);
    expect(id).toBe('owner/repo!42');
  });

  test('should parse issue conversation ID', () => {
    const parsed = parseConversationId('owner/repo#42');
    expect(parsed).toEqual({ owner: 'owner', repo: 'repo', number: 42, isPR: false });
  });

  test('should parse PR conversation ID', () => {
    const parsed = parseConversationId('owner/repo!42');
    expect(parsed).toEqual({ owner: 'owner', repo: 'repo', number: 42, isPR: true });
  });

  test('should return null for invalid format', () => {
    expect(parseConversationId('invalid')).toBeNull();
    expect(parseConversationId('owner/repo@42')).toBeNull();
    expect(parseConversationId('owner/repo#abc')).toBeNull();
  });
});
