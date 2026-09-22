import { describe, expect, test } from 'bun:test';
import { normalizeGitHubWebhook } from './normalize-event';
import { githubConformanceFixtures, verifyGitHubSourceConformance } from './source-conformance';

const context = {
  sourceInstanceId: 'github-primary',
  deliveryId: 'delivery-1',
  contentDigest: 'sha256:body',
  receivedAt: '2026-09-22T10:00:01Z',
  host: 'github.com',
  eventName: 'pull_request',
};

describe('GitHub inbound normalization', () => {
  test('declared capabilities pass their conformance fixtures', () => {
    expect(githubConformanceFixtures.length).toBe(18);
    expect(verifyGitHubSourceConformance()).toEqual([]);
  });

  test('keeps opaque object IDs and zero check PR associations', () => {
    const result = normalizeGitHubWebhook(
      {
        action: 'completed',
        repository: { full_name: 'org/repo' },
        check_run: {
          id: 1,
          name: 'build',
          head_sha: 'not-a-40-character-sha',
          status: 'completed',
          conclusion: 'success',
          pull_requests: [],
        },
      },
      { ...context, eventName: 'check_run' }
    );
    expect(result.status).toBe('normalized');
    if (result.status !== 'normalized' || result.envelope.event.kind !== 'check.changed') return;
    expect(result.envelope.event.revision).toBe('not-a-40-character-sha');
    expect(result.envelope.event.pullRequests).toEqual([]);
  });

  test('does not turn check action requests into completion events', () => {
    for (const action of ['rerequested', 'requested_action', 'future_action']) {
      const result = normalizeGitHubWebhook(
        {
          action,
          repository: { full_name: 'org/repo' },
          check_run: {
            id: 1,
            name: 'build',
            head_sha: 'revision',
            status: 'completed',
            conclusion: 'success',
            pull_requests: [],
          },
        },
        { ...context, eventName: 'check_run' }
      );
      expect(result.status).toBe('unsupported');
    }
  });

  test('distinguishes unsupported actions from malformed supported payloads', () => {
    expect(
      normalizeGitHubWebhook(
        {
          action: 'assigned',
          repository: { full_name: 'org/repo' },
          issue: { number: 1, state: 'open' },
        },
        { ...context, eventName: 'issues' }
      ).status
    ).toBe('unsupported');
    expect(
      normalizeGitHubWebhook({ action: 'opened' }, { ...context, eventName: 'issues' }).status
    ).toBe('malformed');
  });

  test('maps unknown GitHub conclusions to an explicit escape while retaining native state', () => {
    const result = normalizeGitHubWebhook(
      {
        action: 'completed',
        repository: { full_name: 'org/repo' },
        check_run: {
          id: 1,
          name: 'build',
          head_sha: 'opaque',
          status: 'completed',
          conclusion: 'future_conclusion',
          pull_requests: [],
        },
      },
      { ...context, eventName: 'check_run' }
    );
    expect(result.status).toBe('normalized');
    if (result.status !== 'normalized' || result.envelope.event.kind !== 'check.changed') return;
    expect(result.envelope.event).toMatchObject({
      nativeState: 'completed',
      nativeResult: 'future_conclusion',
      result: 'unknown',
    });
  });
});
