import { describe, test, expect } from 'bun:test';
import { interpretPollStatus, type GithubDevicePoll } from './github';

const poll = (
  over: Partial<GithubDevicePoll> & { status: GithubDevicePoll['status'] }
): GithubDevicePoll => ({
  ...over,
});

describe('interpretPollStatus', () => {
  test('connected → stop', () => {
    expect(interpretPollStatus(poll({ status: 'connected', githubLogin: 'octocat' }), 5)).toEqual({
      kind: 'connected',
    });
  });

  test('pending → retry at the same interval', () => {
    expect(interpretPollStatus(poll({ status: 'pending' }), 5)).toEqual({
      kind: 'retry',
      nextInterval: 5,
    });
  });

  test('expired → failed with the expiry message', () => {
    expect(interpretPollStatus(poll({ status: 'expired' }), 5)).toEqual({
      kind: 'failed',
      message: 'Device code expired — try again.',
    });
  });

  test('denied → failed with the denied message', () => {
    expect(interpretPollStatus(poll({ status: 'denied' }), 5)).toEqual({
      kind: 'failed',
      message: 'Authorization was denied.',
    });
  });

  test('error WITH detail → failed, surfacing the detail', () => {
    expect(interpretPollStatus(poll({ status: 'error', detail: 'rate limited' }), 5)).toEqual({
      kind: 'failed',
      message: 'GitHub connect failed: rate limited',
    });
  });

  test('error WITHOUT detail → transient: back off by 2s and retry', () => {
    expect(interpretPollStatus(poll({ status: 'error' }), 5)).toEqual({
      kind: 'retry',
      nextInterval: 7,
    });
  });

  test('error with an empty-string detail is treated as no detail (retry)', () => {
    expect(interpretPollStatus(poll({ status: 'error', detail: '' }), 5)).toEqual({
      kind: 'retry',
      nextInterval: 7,
    });
  });

  test('an unrecognized status (server/type drift) fails terminally, never undefined', () => {
    // Simulate a server status the inlined union doesn't know about.
    const drifted = { status: 'rate_limited' } as unknown as GithubDevicePoll;
    expect(interpretPollStatus(drifted, 5)).toEqual({
      kind: 'failed',
      message: 'Unexpected GitHub poll status: rate_limited',
    });
  });
});
