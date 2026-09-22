import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventEnvelopeSchema,
  mapForgeInputs,
  matchForgeEvent,
  normalizeGitHubWebhook,
} from './index';
import { githubConformanceFixtures, verifyGitHubSourceConformance } from './conformance';

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

describe('authored forge bindings', () => {
  const parsed = forgeEventEnvelopeSchema.parse({
    schemaVersion: 1,
    sourceInstanceId: 'github-primary',
    deliveryId: 'd',
    contentDigest: 'digest',
    receivedAt: '2026-09-22T10:00:01Z',
    occurredAt: null,
    event: {
      kind: 'pr.lifecycle',
      action: 'opened',
      pr: { repo: { host: 'github.com', path: 'org/repo' }, number: 9 },
      state: 'open',
      draft: false,
      head: { objectId: 'opaque', branch: 'feature' },
      base: { objectId: 'base', branch: 'dev' },
    },
  });

  test('matches exact identity and variant predicates', () => {
    expect(
      matchForgeEvent(
        {
          kind: 'pr.lifecycle',
          actions: ['opened'],
          repository: { host: 'github.com', path: 'org/repo' },
          subject: { kind: 'pr', number: 9 },
          predicates: [{ field: 'pr.base.branch', equals: 'dev' }],
        },
        parsed.event
      )
    ).toBe(true);
    expect(
      matchForgeEvent(
        {
          kind: 'pr.lifecycle',
          actions: ['opened'],
          repository: { host: 'github.com', path: 'other' },
        },
        parsed.event
      )
    ).toBe(false);
  });

  test('maps typed literals and direct fields and rejects missing facts', () => {
    const bindingSchema = createForgeInputBindingSchema(
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    );
    const mapping = {
      attempts: bindingSchema.parse({ source: 'literal', value: 3 }),
      pr: bindingSchema.parse({ source: 'field', field: 'subject.number' }),
    };
    expect(mapForgeInputs(mapping, parsed.event)).toEqual({
      ok: true,
      inputs: { attempts: 3, pr: 9 },
    });
    expect(
      mapForgeInputs(
        { result: bindingSchema.parse({ source: 'field', field: 'check.result' }) },
        parsed.event
      )
    ).toEqual({
      ok: false,
      input: 'result',
      field: 'check.result',
      reason: 'Required event field check.result is unavailable',
    });
  });

  test('rejects selector and input fields that cannot exist on the selected variant', () => {
    const bindingSchema = createForgeBindingSchema(
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    );
    expect(() =>
      bindingSchema.parse({
        selector: {
          kind: 'issue.lifecycle',
          actions: ['merged'],
          predicates: [{ field: 'check.result', equals: 'success' }],
        },
        inputs: { result: { source: 'field', field: 'check.result' } },
      })
    ).toThrow();
    expect(() =>
      bindingSchema.parse({
        selector: { kind: 'check.changed', actions: ['changed'] },
        inputs: { result: { source: 'field', field: 'check.result' } },
      })
    ).not.toThrow();
  });
});
