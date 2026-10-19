import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { fetchCommentHistory, hasMention, stripMention } from './webhook-intake';
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

type ListComments = GitHubApi['rest']['issues']['listComments'];

function makeListCommentsMock(
  data: Awaited<ReturnType<ListComments>>['data'] = []
): Mock<ListComments> {
  return mock(async () => ({ data }));
}

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
  function fetchHistory(listComments: Mock<ListComments>): Promise<string[]> {
    const octokit = { rest: { issues: { listComments } } } as unknown as GitHubApi;
    return fetchCommentHistory((_owner, _repo, fn) => fn(octokit), 'owner', 'repo', 123);
  }

  test('should fetch and format comment history', async () => {
    const mockListComments = makeListCommentsMock([
      // API returns in desc order (newest first) because direction: 'desc'
      { user: { login: 'user3' }, body: 'Third comment' },
      { user: { login: 'user2' }, body: 'Second comment' },
      { user: { login: 'user1' }, body: 'First comment' },
    ]);

    const history = await fetchHistory(mockListComments);

    expect(mockListComments).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      per_page: 20,
      sort: 'created',
      direction: 'desc',
    });

    // Should return in chronological order (oldest first) after reverse
    expect(history).toEqual([
      'user1: First comment',
      'user2: Second comment',
      'user3: Third comment',
    ]);
  });

  test('should preserve full comment content without truncation', async () => {
    const longBody = 'a'.repeat(5000);
    const history = await fetchHistory(
      makeListCommentsMock([{ user: { login: 'user1' }, body: longBody }])
    );

    expect(history).toHaveLength(1);
    expect(history[0]).toBe(`user1: ${longBody}`);
    expect(history[0]).toHaveLength(5007); // 'user1: ' (7 chars) + 5000 chars
  });

  test('should handle comments without user or body (null and undefined)', async () => {
    const history = await fetchHistory(
      makeListCommentsMock([
        { user: null, body: 'Comment without user' },
        { user: { login: 'user1' }, body: null },
        { user: { login: 'user2' } }, // body property not present (undefined)
      ])
    );

    // Reversed from desc order, handles null user, null body, and undefined body
    expect(history).toEqual(['user2: ', 'user1: ', 'unknown: Comment without user']);
  });

  test('should return empty array on API error', async () => {
    const history = await fetchHistory(
      makeListCommentsMock().mockRejectedValue(new Error('API rate limit exceeded'))
    );

    expect(history).toEqual([]);
  });

  test('should handle empty comment list', async () => {
    expect(await fetchHistory(makeListCommentsMock())).toEqual([]);
  });
});
