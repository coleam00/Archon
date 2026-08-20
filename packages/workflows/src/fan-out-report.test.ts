import { describe, it, expect } from 'bun:test';

import {
  FAN_OUT_EXCERPT_MAX_CHARS,
  fanOutExcerpt,
  childDispositionSchema,
  fanOutReportPayloadSchema,
  tallyChildDispositions,
  parseFanOutReport,
  formatFanOutHeadline,
  formatFanOutBreakdown,
  formatFanOutTally,
  neverRan,
  ranFailed,
  toChildDisposition,
  buildFanOutReportPayload,
  formatChildDispositionLine,
} from './schemas/fan-out-report';
import type { ChildDisposition, ChildWorkflowOutcome } from './schemas/fan-out-report';

describe('fan-out-report: dispositions + tally', () => {
  const mixed: ChildDisposition[] = [
    { kind: 'completed', index: 0, childRunId: 'run-a' },
    { kind: 'failed', index: 1, childRunId: 'run-b', error: 'boom' },
    { kind: 'cancelled_by_engine', index: 2, childRunId: 'run-c', reason: 'fan_out_gate' },
    { kind: 'cancelled_out_of_band', index: 3, childRunId: 'run-d' },
    { kind: 'never_ran', index: 4, reason: 'unresolved_target', error: 'no such workflow' },
  ];

  it('derives an exhaustive tally over mixed dispositions', () => {
    const tally = tallyChildDispositions(mixed);
    expect(tally.total).toBe(5);
    expect(tally.completed).toBe(1);
    expect(tally.failed).toBe(1);
    expect(tally.cancelledByEngine).toBe(1);
    expect(tally.cancelledOutOfBand).toBe(1);
    expect(tally.neverRan).toBe(1);
    // notCompleted = total - completed (every non-completed slot).
    expect(tally.notCompleted).toBe(4);
  });

  it('a clean all-completed fan-out has notCompleted 0', () => {
    const tally = tallyChildDispositions([
      { kind: 'completed', index: 0, childRunId: 'a' },
      { kind: 'completed', index: 1, childRunId: 'b' },
    ]);
    expect(tally.notCompleted).toBe(0);
    expect(tally.completed).toBe(2);
  });

  it('the tally is derived, not stored on the wire payload', () => {
    // The persisted payload carries ONLY { children } — no tally field.
    const payload = { children: mixed };
    const parsed = fanOutReportPayloadSchema.parse(payload);
    expect(Object.keys(parsed)).toEqual(['children']);
    expect('tally' in parsed).toBe(false);
  });
});

describe('fan-out-report: schema rejects unrepresentable states', () => {
  it('never_ran cannot carry a childRunId (extra key stripped by zod)', () => {
    const withId = {
      kind: 'never_ran',
      index: 0,
      reason: 'unresolved_target',
      error: 'x',
      childRunId: 'sneaky',
    };
    // The never_ran variant has no childRunId field; a childRunId key is not part of its
    // shape. zod object() strips unknown keys by default, so assert the parsed result has
    // no childRunId rather than relying on rejection.
    const parsed = childDispositionSchema.parse(withId);
    expect('childRunId' in parsed).toBe(false);
  });

  it('a completed disposition rejects an empty childRunId', () => {
    const bad = childDispositionSchema.safeParse({ kind: 'completed', index: 0, childRunId: '' });
    expect(bad.success).toBe(false);
  });

  it('rejects a negative index', () => {
    const bad = childDispositionSchema.safeParse({ kind: 'completed', index: -1, childRunId: 'a' });
    expect(bad.success).toBe(false);
  });

  it('rejects an unknown engine cancel reason', () => {
    const bad = childDispositionSchema.safeParse({
      kind: 'cancelled_by_engine',
      index: 0,
      childRunId: 'a',
      reason: 'user_cancel',
    });
    expect(bad.success).toBe(false);
  });
});

describe('fan-out-report: parseFanOutReport', () => {
  it('parses a valid payload and attaches the derived tally', () => {
    const report = parseFanOutReport({
      children: [
        { kind: 'completed', index: 0, childRunId: 'a' },
        { kind: 'failed', index: 1, childRunId: 'b', error: 'boom' },
      ],
    });
    expect(report).not.toBeNull();
    expect(report?.children.length).toBe(2);
    expect(report?.tally.failed).toBe(1);
    expect(report?.tally.notCompleted).toBe(1);
  });

  it('legacy boolean fan_out: true parses to null (no migration)', () => {
    expect(parseFanOutReport(true)).toBeNull();
  });

  it('malformed payloads parse to null', () => {
    expect(parseFanOutReport(undefined)).toBeNull();
    expect(parseFanOutReport(null)).toBeNull();
    expect(parseFanOutReport('garbage')).toBeNull();
    expect(parseFanOutReport({ children: 'not-an-array' })).toBeNull();
    expect(parseFanOutReport({ children: [{ kind: 'bogus', index: 0 }] })).toBeNull();
  });

  it('an empty fan-out is a valid report, not null', () => {
    const report = parseFanOutReport({ children: [] });
    expect(report).not.toBeNull();
    expect(report?.tally.total).toBe(0);
    expect(report?.tally.notCompleted).toBe(0);
  });
});

describe('fan-out-report: toChildDisposition', () => {
  it('maps a ran+completed outcome to completed', () => {
    const d = toChildDisposition(
      { kind: 'ran', childRunId: 'run-1', status: 'completed', output: 'hi' },
      0
    );
    expect(d).toEqual({ kind: 'completed', index: 0, childRunId: 'run-1' });
  });

  it('maps a ran+failed outcome to failed with an excerpt', () => {
    const d = toChildDisposition(ranFailed('run-2', 'DAG failed'), 3);
    expect(d).toEqual({ kind: 'failed', index: 3, childRunId: 'run-2', error: 'DAG failed' });
  });

  it('maps a cancelled child with an engine reason to cancelled_by_engine', () => {
    const d = toChildDisposition(
      { kind: 'ran', childRunId: 'run-3', status: 'cancelled', cancelledReason: 'fan_out_orphan' },
      1
    );
    expect(d).toEqual({
      kind: 'cancelled_by_engine',
      index: 1,
      childRunId: 'run-3',
      reason: 'fan_out_orphan',
    });
  });

  it('maps a cancelled child WITHOUT a known reason to cancelled_out_of_band', () => {
    const d = toChildDisposition({ kind: 'ran', childRunId: 'run-4', status: 'cancelled' }, 2);
    expect(d).toEqual({ kind: 'cancelled_out_of_band', index: 2, childRunId: 'run-4' });
  });

  it('maps a cancelled child with a non-engine reason to cancelled_out_of_band, carrying the error', () => {
    const d = toChildDisposition(
      {
        kind: 'ran',
        childRunId: 'run-5',
        status: 'cancelled',
        cancelledReason: 'user_requested',
        error: 'cancelled by user',
      },
      0
    );
    expect(d).toEqual({
      kind: 'cancelled_out_of_band',
      index: 0,
      childRunId: 'run-5',
      error: 'cancelled by user',
    });
  });

  it('maps a never_ran outcome to never_ran (no childRunId)', () => {
    const d = toChildDisposition(neverRan('unresolved_target', 'Unknown workflow'), 4);
    expect(d).toEqual({
      kind: 'never_ran',
      index: 4,
      reason: 'unresolved_target',
      error: 'Unknown workflow',
    });
    expect('childRunId' in d).toBe(false);
  });

  it('truncates wire error excerpts to the bounded length', () => {
    const long = 'x'.repeat(FAN_OUT_EXCERPT_MAX_CHARS + 50);
    const d = toChildDisposition(ranFailed('run-6', long), 0);
    if (d.kind !== 'failed') throw new Error('expected failed');
    expect(d.error.length).toBe(FAN_OUT_EXCERPT_MAX_CHARS);
    expect(d.error.endsWith('…')).toBe(true);
  });

  it('buildFanOutReportPayload preserves order and length', () => {
    const outcomes: ChildWorkflowOutcome[] = [
      { kind: 'ran', childRunId: 'a', status: 'completed' },
      neverRan('unresolved_target', 'nope'),
      ranFailed('c', 'boom'),
    ];
    const payload = buildFanOutReportPayload(outcomes);
    expect(payload.children.map(c => c.index)).toEqual([0, 1, 2]);
    expect(payload.children.map(c => c.kind)).toEqual(['completed', 'never_ran', 'failed']);
  });
});

describe('fan-out-report: fanOutExcerpt', () => {
  it('leaves short strings unchanged', () => {
    expect(fanOutExcerpt('short')).toBe('short');
  });

  it('truncates long strings with an ellipsis', () => {
    const out = fanOutExcerpt('abcdef', 4);
    expect(out).toBe('abc…');
    expect(out.length).toBe(4);
  });
});

describe('fan-out-report: formatting', () => {
  const failedTally = tallyChildDispositions([
    { kind: 'completed', index: 0, childRunId: 'a' },
    { kind: 'completed', index: 1, childRunId: 'b' },
    { kind: 'failed', index: 2, childRunId: 'c', error: 'boom' },
  ]);
  const neverRanTally = tallyChildDispositions([
    { kind: 'never_ran', index: 0, reason: 'unresolved_target', error: 'x' },
    { kind: 'never_ran', index: 1, reason: 'unresolved_target', error: 'x' },
    { kind: 'never_ran', index: 2, reason: 'unresolved_target', error: 'x' },
  ]);

  it('headline says "did not complete", not "failed"', () => {
    expect(formatFanOutHeadline(failedTally)).toBe('1 of 3 children did not complete');
    expect(formatFanOutHeadline(neverRanTally)).toBe('3 of 3 children did not complete');
  });

  it('uses the singular "child" for a single-slot fan-out', () => {
    const one = tallyChildDispositions([
      { kind: 'never_ran', index: 0, reason: 'slot_threw', error: 'x' },
    ]);
    expect(formatFanOutHeadline(one)).toBe('1 of 1 child did not complete');
  });

  it('breakdown lists non-zero categories, cancels generic', () => {
    expect(formatFanOutBreakdown(failedTally)).toBe('2 completed, 1 failed');
    expect(formatFanOutBreakdown(neverRanTally)).toBe('3 never ran');
    const cancels = tallyChildDispositions([
      { kind: 'cancelled_by_engine', index: 0, childRunId: 'a', reason: 'fan_out_gate' },
      { kind: 'cancelled_out_of_band', index: 1, childRunId: 'b' },
    ]);
    expect(formatFanOutBreakdown(cancels)).toBe('2 cancelled');
  });

  it('full tally combines headline and breakdown', () => {
    expect(formatFanOutTally(failedTally)).toBe(
      '1 of 3 children did not complete (2 completed, 1 failed)'
    );
    expect(formatFanOutTally(neverRanTally)).toBe('3 of 3 children did not complete (3 never ran)');
  });

  it('indexed child lines carry the specific reason', () => {
    expect(
      formatChildDispositionLine({
        kind: 'never_ran',
        index: 0,
        reason: 'unresolved_target',
        error: "Unknown sub-run workflow 'typo'.",
      })
    ).toBe("[0] never ran · Unknown sub-run workflow 'typo'.");
    expect(
      formatChildDispositionLine({
        kind: 'cancelled_by_engine',
        index: 2,
        childRunId: 'abcdef1234',
        reason: 'fan_out_gate',
      })
    ).toBe('[2] cancelled (fan_out_gate) · abcdef12');
    expect(
      formatChildDispositionLine({
        kind: 'failed',
        index: 1,
        childRunId: 'deadbeef99',
        error: 'DAG failed',
      })
    ).toBe('[1] failed · deadbeef · DAG failed');
  });
});
