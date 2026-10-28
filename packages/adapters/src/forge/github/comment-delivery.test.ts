import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { CommentDelivery } from './comment-delivery';
import type { GitHubApi } from './types';
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

type CreateComment = GitHubApi['rest']['issues']['createComment'];

function makeCreateCommentMock(): Mock<CreateComment> {
  return mock(async () => ({ data: {} }));
}

/** PAT-mode delivery whose API calls all reach `createComment`. */
function createDelivery(
  createComment: Mock<CreateComment>,
  retryDelayMs: (attempt: number) => number = attempt => 1000 * attempt
): CommentDelivery {
  const octokit = { rest: { issues: { createComment } } } as unknown as GitHubApi;
  return new CommentDelivery({
    appMode: false,
    apiBaseUrl: 'https://api.github.com',
    callApi: (_owner, _repo, fn) => fn(octokit),
    retryDelayMs,
  });
}

describe('conversationId format', () => {
  test('should parse valid owner/repo#number format', async () => {
    const mockCreateComment = makeCreateCommentMock();

    await createDelivery(mockCreateComment).send('owner/repo#123', 'test');

    expect(mockCreateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: 'test\n\n<!-- archon-bot-response -->',
    });
  });

  test('postComment appends bot marker to outgoing comments', async () => {
    const mockCreateComment = makeCreateCommentMock();

    await createDelivery(mockCreateComment).send('owner/repo#123', 'Hello world');

    const body = mockCreateComment.mock.calls[0][0].body as string;
    expect(body).toContain('Hello world');
    expect(body).toContain('<!-- archon-bot-response -->');
    expect(body).toBe('Hello world\n\n<!-- archon-bot-response -->');
  });

  test('should reject invalid conversationId format', async () => {
    const mockCreateComment = makeCreateCommentMock();

    // Invalid format (pr-42 is not a number) should return early without calling API
    await createDelivery(mockCreateComment).send('owner/repo#pr-42', 'test');
    expect(mockCreateComment).not.toHaveBeenCalled();
  });
});

describe('message splitting', () => {
  test('should split long messages into multiple chunks', async () => {
    const mockCreateComment = makeCreateCommentMock();

    // Create message exceeding MAX_LENGTH (65000)
    const paragraph1 = 'a'.repeat(40000);
    const paragraph2 = 'b'.repeat(30000);
    const message = `${paragraph1}\n\n${paragraph2}`;

    await createDelivery(mockCreateComment).send('owner/repo#123', message);

    // Should have sent 2 separate comments
    expect(mockCreateComment).toHaveBeenCalledTimes(2);

    // First chunk should contain paragraph1
    expect(mockCreateComment).toHaveBeenNthCalledWith(1, {
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('aaa'),
    });

    // Second chunk should contain paragraph2
    expect(mockCreateComment).toHaveBeenNthCalledWith(2, {
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('bbb'),
    });

    // Verify chunk sizes are within limits
    const firstChunkBody = mockCreateComment.mock.calls[0][0].body as string;
    const secondChunkBody = mockCreateComment.mock.calls[1][0].body as string;
    expect(firstChunkBody.length).toBeLessThanOrEqual(65000);
    expect(secondChunkBody.length).toBeLessThanOrEqual(65000);
  });

  test('should not split message at exactly MAX_LENGTH', async () => {
    const mockCreateComment = makeCreateCommentMock();

    // Message exactly at MAX_LENGTH (65000) should not be split
    await createDelivery(mockCreateComment).send('owner/repo#123', 'a'.repeat(65000));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test('should handle message without paragraph breaks', async () => {
    const mockCreateComment = makeCreateCommentMock();

    // Message under MAX_LENGTH with no paragraph breaks
    await createDelivery(mockCreateComment).send('owner/repo#123', 'a'.repeat(50000));

    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test('should throw error when chunk posting fails', async () => {
    const mockCreateComment = makeCreateCommentMock()
      .mockResolvedValueOnce({ data: {} }) // First chunk succeeds
      .mockRejectedValueOnce(new Error('API rate limit exceeded')); // Second chunk fails

    // Create message that will be split into 2 chunks
    const paragraph1 = 'a'.repeat(40000);
    const paragraph2 = 'b'.repeat(30000);
    const message = `${paragraph1}\n\n${paragraph2}`;

    // Should throw with context about partial delivery
    await expect(createDelivery(mockCreateComment).send('owner/repo#123', message)).rejects.toThrow(
      /Failed to post comment chunk 2\/2/
    );

    // First chunk should have been posted
    expect(mockCreateComment).toHaveBeenCalledTimes(2);
  });
});

describe('retry logic', () => {
  test('should retry on transient network errors', async () => {
    const mockCreateComment = makeCreateCommentMock()
      .mockRejectedValueOnce(new Error('fetch failed')) // First attempt fails
      .mockResolvedValueOnce({ data: {} }); // Second attempt succeeds

    await createDelivery(mockCreateComment, () => 1).send('owner/repo#123', 'test message');

    // Should have retried once
    expect(mockCreateComment).toHaveBeenCalledTimes(2);
  });

  test('should retry on transient status errors', async () => {
    const transientError = Object.assign(new Error('Gateway failure'), { status: 502 });
    const mockCreateComment = makeCreateCommentMock()
      .mockRejectedValueOnce(transientError) // First attempt fails
      .mockResolvedValueOnce({ data: {} }); // Second attempt succeeds

    await createDelivery(mockCreateComment, () => 1).send('owner/repo#123', 'test message');

    // Should have retried once for structured 502 status
    expect(mockCreateComment).toHaveBeenCalledTimes(2);
  });

  test('should not retry on non-retryable errors', async () => {
    const mockCreateComment = makeCreateCommentMock().mockRejectedValue(
      new Error('Bad credentials')
    );

    // Should throw immediately without retry
    await expect(
      createDelivery(mockCreateComment).send('owner/repo#123', 'test message')
    ).rejects.toThrow('Bad credentials');

    // Should only have tried once (no retry for auth errors)
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test('should not retry on auth status errors', async () => {
    const authError = Object.assign(new Error('Unauthorized'), { status: 401 });
    const mockCreateComment = makeCreateCommentMock().mockRejectedValue(authError);

    // Should throw immediately without retry
    await expect(
      createDelivery(mockCreateComment).send('owner/repo#123', 'test message')
    ).rejects.toThrow('Unauthorized');

    // Should only have tried once (no retry for auth errors)
    expect(mockCreateComment).toHaveBeenCalledTimes(1);
  });

  test('should throw after exhausting retries', async () => {
    const mockCreateComment = makeCreateCommentMock().mockRejectedValue(new Error('fetch failed'));

    // Should throw after 3 attempts
    await expect(
      createDelivery(mockCreateComment, () => 1).send('owner/repo#123', 'test message')
    ).rejects.toThrow('fetch failed');

    // Should have tried 3 times (max retries)
    expect(mockCreateComment).toHaveBeenCalledTimes(3);
  });
});

describe('per-user attribution', () => {
  test('the per-user client posts to the configured API root', async () => {
    const createComment = makeCreateCommentMock();
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );
    try {
      const delivery = new CommentDelivery({
        appMode: true,
        apiBaseUrl: 'https://ghe.example/api/v3',
        callApi: (_owner, _repo, fn) =>
          fn({ rest: { issues: { createComment } } } as unknown as GitHubApi),
        retryDelayMs: () => 0,
        getUserToken: async () => 'user-token',
      });
      delivery.rememberActor('owner/repo#7', 'user-1');

      await delivery.send('owner/repo#7', 'hello');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [request] = fetchSpy.mock.calls[0] as [string | URL | Request];
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toBe('https://ghe.example/api/v3/repos/owner/repo/issues/7/comments');
      expect(createComment).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
