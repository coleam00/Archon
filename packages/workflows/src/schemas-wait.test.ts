// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { isWaitNode, dagNodeSchema, MAX_DURABLE_WAIT_MS, waitConfigSchema } from './schemas';
import type { DagNode, WaitConfig } from './schemas';

describe('dagNodeSchema — durable wait', () => {
  test('normalizes duration, until, bounded event, and attention waits', () => {
    const duration = dagNodeSchema.parse({ id: 'later', wait: { duration_ms: 5000 } });
    const until = dagNodeSchema.parse({
      id: 'clock',
      wait: { until: '2026-08-25T10:00:00Z' },
    });
    const event = dagNodeSchema.parse({
      id: 'ci',
      wait: { event: 'checks.complete', deadline_ms: 60_000 },
    });
    const attention = dagNodeSchema.parse({
      id: 'recover',
      wait: { attention: '  Rerun CI, then resume.  ' },
    });
    expect(isWaitNode(duration as DagNode)).toBe(true);
    expect((until as DagNode).kind).toBe('wait');
    expect((event as DagNode).kind).toBe('wait');
    expect((event as DagNode).output_format?.required).toEqual(['status', 'waited_ms']);
    expect((attention as DagNode).kind).toBe('wait');
    expect((attention as DagNode & { wait: { attention: string } }).wait.attention).toBe(
      'Rerun CI, then resume.'
    );
  });

  test('rejects ambiguous and unbounded waits', () => {
    const mixedWait = { duration_ms: 1, until: '2026-08-25T10:00:00Z' };
    // @ts-expect-error A programmatic caller must not be able to construct two wait variants.
    const invalidTypedWait: WaitConfig = mixedWait;
    expect(waitConfigSchema.safeParse(invalidTypedWait).success).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'mixed', wait: { duration_ms: 1, until: 'later' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'event', wait: { event: 'checks.complete' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'blank-event', wait: { event: '   ', deadline_ms: 1 } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'blank-attention', wait: { attention: '   ' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({
        id: 'mixed-attention',
        wait: { attention: 'Resume me', duration_ms: 1 },
      }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'duration', wait: { duration_ms: 1, deadline_ms: 2 } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({
        id: 'custom-output',
        wait: { duration_ms: 1 },
        output_format: { type: 'string' },
      }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'repeating', wait: { duration_ms: 1 }, always_run: true })
        .success
    ).toBe(false);
    const retried = dagNodeSchema.safeParse({
      id: 'retried',
      wait: { duration_ms: 1 },
      retry: { max_attempts: 2 },
    });
    expect(retried.success).toBe(false);
    expect(retried.error?.issues.map(issue => issue.path)).toEqual([['retry']]);
    expect(
      dagNodeSchema.safeParse({ id: 'invalid-date', wait: { until: 'tomorrow' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'stray-dollar', wait: { until: 'tomorrow$' } }).success
    ).toBe(false);
    expect(
      dagNodeSchema.safeParse({ id: 'dynamic-date', wait: { until: '$schedule.output' } }).success
    ).toBe(true);
    expect(
      dagNodeSchema.safeParse({ id: 'input-date', wait: { until: '$INPUTS.resume_at' } }).success
    ).toBe(true);
    expect(
      dagNodeSchema.safeParse({ id: 'date-only', wait: { until: '2026-08-25' } }).success
    ).toBe(false);
  });

  test('bounds persisted delays before they can overflow their timestamps', () => {
    expect(waitConfigSchema.safeParse({ duration_ms: MAX_DURABLE_WAIT_MS }).success).toBe(true);
    expect(waitConfigSchema.safeParse({ duration_ms: MAX_DURABLE_WAIT_MS + 1 }).success).toBe(
      false
    );
    expect(
      waitConfigSchema.safeParse({
        event: 'checks.complete',
        deadline_ms: MAX_DURABLE_WAIT_MS,
      }).success
    ).toBe(true);
    expect(
      waitConfigSchema.safeParse({
        event: 'checks.complete',
        deadline_ms: MAX_DURABLE_WAIT_MS + 1,
      }).success
    ).toBe(false);
  });
});
