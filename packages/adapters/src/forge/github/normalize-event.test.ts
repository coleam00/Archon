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
    expect(githubConformanceFixtures.length).toBe(20);
    expect(verifyGitHubSourceConformance()).toEqual([]);
  });

  test('a label event names who changed the label', () => {
    for (const [eventName, item] of [
      ['issues', { issue: { number: 3, state: 'open' } }],
      ['pull_request', { pull_request: { number: 3, state: 'open' } }],
    ] as const) {
      const labelled = (sender?: object) =>
        normalizeGitHubWebhook(
          {
            action: 'labeled',
            repository: { full_name: 'org/repo' },
            label: { id: 5, name: 'archon-triage' },
            ...item,
            ...(sender ? { sender } : {}),
          },
          { ...context, eventName }
        );
      expect(labelled({ id: 42, login: 'maintainer' })).toMatchObject({
        status: 'normalized',
        envelope: { event: { actor: { host: 'github.com', id: '42', login: 'maintainer' } } },
      });
      expect(labelled()).toMatchObject({
        status: 'normalized',
        envelope: { event: { actor: null } },
      });
    }
  });

  test('a created comment is delivered with its subject kind and author, never its text', () => {
    const commented = (issue: object, action = 'created') =>
      normalizeGitHubWebhook(
        {
          action,
          repository: { full_name: 'org/repo' },
          sender: { id: 1, login: 'commenter' },
          issue,
          comment: { id: 77, user: { id: 9, login: 'author' }, body: 'private reply' },
        },
        { ...context, eventName: 'issue_comment' }
      );
    const onIssue = commented({ number: 4 });
    expect(onIssue).toMatchObject({
      status: 'normalized',
      envelope: {
        event: {
          kind: 'comment.changed',
          action: 'created',
          subject: { kind: 'issue', ref: { repo: { path: 'org/repo' }, number: 4 } },
          comment: { id: '77', author: { id: '9', login: 'author' } },
        },
      },
    });
    expect(JSON.stringify(onIssue)).not.toContain('private reply');
    expect(commented({ number: 5, pull_request: {} })).toMatchObject({
      envelope: { event: { subject: { kind: 'pr' } } },
    });
    expect(commented({ number: 4 }, 'edited').status).toBe('unsupported');
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
