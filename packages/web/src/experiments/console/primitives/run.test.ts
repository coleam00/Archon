import { describe, test, expect } from 'bun:test';
import { toRun, normalizeOrigin } from './run';

type Raw = Parameters<typeof toRun>[0];

function raw(over: Partial<Raw> & { id: string; workflow_name: string; status: string }): Raw {
  return {
    codebase_id: null,
    started_at: '2026-06-05T10:00:00Z',
    ...over,
  };
}

describe('normalizeOrigin', () => {
  test('maps each known platform_type to its RunOrigin', () => {
    expect(normalizeOrigin('web')).toBe('web');
    expect(normalizeOrigin('cli')).toBe('cli');
    expect(normalizeOrigin('slack')).toBe('slack');
    expect(normalizeOrigin('telegram')).toBe('telegram');
    expect(normalizeOrigin('discord')).toBe('discord');
    expect(normalizeOrigin('github')).toBe('github');
  });

  test('is case-insensitive', () => {
    expect(normalizeOrigin('CLI')).toBe('cli');
    expect(normalizeOrigin('GitHub')).toBe('github');
  });

  test('null, undefined, and unknown strings fall back to "unknown"', () => {
    expect(normalizeOrigin(null)).toBe('unknown');
    expect(normalizeOrigin(undefined)).toBe('unknown');
    expect(normalizeOrigin('carrier-pigeon')).toBe('unknown');
  });
});

describe('toRun — provenance', () => {
  test('userMessage defaults to empty string when absent', () => {
    const r = toRun(raw({ id: 'r1', workflow_name: 'plan', status: 'running' }));
    expect(r.userMessage).toBe('');
  });

  test('userMessage passes through when present', () => {
    const r = toRun(
      raw({ id: 'r1', workflow_name: 'plan', status: 'running', user_message: 'summarise PRs' })
    );
    expect(r.userMessage).toBe('summarise PRs');
  });

  test('origin is derived from platform_type', () => {
    const r = toRun(
      raw({ id: 'r1', workflow_name: 'plan', status: 'running', platform_type: 'web' })
    );
    expect(r.origin).toBe('web');
  });

  test('detail-sourced row still populates conversationPlatformId (unchanged behavior)', () => {
    const r = toRun(
      raw({
        id: 'r1',
        workflow_name: 'plan',
        status: 'completed',
        conversation_platform_id: 'cli-detail-789',
      })
    );
    expect(r.conversationPlatformId).toBe('cli-detail-789');
  });

  test("normalizes the transient 'pending' status to running", () => {
    const r = toRun(raw({ id: 'r1', workflow_name: 'plan', status: 'pending' }));
    expect(r.status).toBe('running');
  });

  test('an unrecognised status falls back to running', () => {
    const r = toRun(raw({ id: 'r1', workflow_name: 'plan', status: 'banana' }));
    expect(r.status).toBe('running');
  });
});

describe('toRun — cost', () => {
  test('reads a positive total_cost_usd from metadata', () => {
    const r = toRun(
      raw({
        id: 'r1',
        workflow_name: 'plan',
        status: 'completed',
        metadata: { total_cost_usd: 1.5 },
      })
    );
    expect(r.costUsd).toBe(1.5);
  });

  test('treats $0.00 (and non-positive) as null — the > 0 guard', () => {
    const zero = toRun(
      raw({ id: 'r1', workflow_name: 'plan', status: 'completed', metadata: { total_cost_usd: 0 } })
    );
    expect(zero.costUsd).toBeNull();
  });

  test('cost is null when metadata is absent or non-numeric', () => {
    expect(toRun(raw({ id: 'r1', workflow_name: 'plan', status: 'completed' })).costUsd).toBeNull();
    expect(
      toRun(
        raw({
          id: 'r1',
          workflow_name: 'plan',
          status: 'completed',
          metadata: { total_cost_usd: 'free' },
        })
      ).costUsd
    ).toBeNull();
  });
});

describe('toRun — approval parsing', () => {
  test('parses a well-formed approval from metadata', () => {
    const r = toRun(
      raw({
        id: 'r1',
        workflow_name: 'review',
        status: 'paused',
        metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
      })
    );
    expect(r.approval).toEqual({ nodeId: 'gate', message: 'Approve?' });
  });

  test('defaults message to empty string when only nodeId is present', () => {
    const r = toRun(
      raw({
        id: 'r1',
        workflow_name: 'review',
        status: 'paused',
        metadata: { approval: { nodeId: 'gate' } },
      })
    );
    expect(r.approval).toEqual({ nodeId: 'gate', message: '' });
  });

  test('approval is null when absent or malformed (no string nodeId)', () => {
    expect(toRun(raw({ id: 'r1', workflow_name: 'review', status: 'paused' })).approval).toBeNull();
    expect(
      toRun(
        raw({
          id: 'r1',
          workflow_name: 'review',
          status: 'paused',
          metadata: { approval: { message: 'no node id' } },
        })
      ).approval
    ).toBeNull();
  });
});
