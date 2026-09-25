import type { EventActionCapability } from '@archon/forge';
import { verifyForgeSourceConformance } from '@archon/forge/conformance';
import {
  githubSourceCapabilities,
  normalizeGitHubWebhook,
  type GitHubEnvelopeContext,
} from './normalize-event';

export interface GitHubConformanceFixture {
  name: string;
  eventName: string;
  payload: unknown;
  capability: EventActionCapability;
}

const repository = { full_name: 'owner/nested/repo' };
const sender = { id: 7, login: 'octocat' };
const issue = { number: 12, state: 'open', updated_at: '2026-09-22T10:00:00Z' };
const pullRequest = {
  number: 14,
  state: 'open',
  draft: false,
  merged: false,
  updated_at: '2026-09-22T10:00:00Z',
  head: { sha: 'sha256:opaque-head', ref: 'feature' },
  base: { sha: 'sha256:opaque-base', ref: 'dev' },
};

export const githubConformanceFixtures = [
  ...(['opened', 'edited', 'closed', 'reopened'] as const).map(action => ({
    name: `issues.${action}`,
    eventName: 'issues',
    payload: {
      action,
      repository,
      sender,
      issue: { ...issue, state: action === 'closed' ? 'closed' : 'open' },
    },
    capability: { kind: 'issue.lifecycle' as const, action },
  })),
  ...(
    [
      ['opened', 'opened'],
      ['edited', 'edited'],
      ['synchronize', 'head_updated'],
      ['ready_for_review', 'ready'],
      ['converted_to_draft', 'drafted'],
      ['closed', 'closed'],
      ['reopened', 'reopened'],
    ] as const
  ).map(([githubAction, action]) => ({
    name: `pull_request.${githubAction}`,
    eventName: 'pull_request',
    payload: {
      action: githubAction,
      repository,
      sender,
      pull_request: { ...pullRequest, state: githubAction === 'closed' ? 'closed' : 'open' },
    },
    capability: { kind: 'pr.lifecycle' as const, action },
  })),
  {
    name: 'pull_request.closed.merged',
    eventName: 'pull_request',
    payload: {
      action: 'closed',
      repository,
      sender,
      pull_request: {
        ...pullRequest,
        state: 'closed',
        merged: true,
        merged_at: '2026-09-22T10:00:00Z',
      },
    },
    capability: { kind: 'pr.lifecycle', action: 'merged' },
  },
  ...(['issues', 'pull_request'] as const).flatMap(eventName =>
    (
      [
        ['labeled', 'added'],
        ['unlabeled', 'removed'],
      ] as const
    ).map(([action, normalizedAction]) => ({
      name: `${eventName}.${action}`,
      eventName,
      payload: {
        action,
        repository,
        sender,
        issue,
        pull_request: pullRequest,
        label: { id: 99, name: 'automation' },
      },
      capability: {
        kind: 'label.changed' as const,
        action: normalizedAction,
      },
    }))
  ),
  {
    name: 'check_run.completed',
    eventName: 'check_run',
    payload: {
      action: 'completed',
      repository,
      sender,
      check_run: {
        id: 100,
        name: 'build',
        head_sha: 'sha256:opaque-check',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-22T10:00:00Z',
        pull_requests: [],
      },
    },
    capability: { kind: 'check.changed', action: 'changed', unitKind: 'check' },
  },
  {
    name: 'status.success',
    eventName: 'status',
    payload: {
      id: 101,
      sha: 'sha256:opaque-status',
      context: 'ci/build',
      state: 'success',
      updated_at: '2026-09-22T10:00:00Z',
      repository,
      sender,
    },
    capability: { kind: 'check.changed', action: 'changed', unitKind: 'commit_status' },
  },
] as const satisfies readonly GitHubConformanceFixture[];

export function verifyGitHubSourceConformance(
  normalize: typeof normalizeGitHubWebhook = normalizeGitHubWebhook
): string[] {
  const context: Omit<GitHubEnvelopeContext, 'eventName'> = {
    sourceInstanceId: 'github-primary',
    deliveryId: 'delivery',
    contentDigest: 'sha256:digest',
    receivedAt: '2026-09-22T10:00:01Z',
    host: 'github.com',
  };
  return verifyForgeSourceConformance(
    githubSourceCapabilities,
    githubConformanceFixtures,
    fixture => normalize(fixture.payload, { ...context, eventName: fixture.eventName })
  );
}
