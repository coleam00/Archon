import { describe, test, expect } from 'bun:test';
import {
  parseFanOutReport,
  tallyChildDispositions,
  formatFanOutHeadline,
  formatFanOutBreakdown,
  formatFanOutTally,
  formatChildDispositionLine,
  summarizeRunFanOut,
  type ChildDisposition,
  type FanOutReport,
} from './fan-out';

const mixed: ChildDisposition[] = [
  { kind: 'completed', index: 0, childRunId: 'run-a' },
  { kind: 'failed', index: 1, childRunId: 'run-b', error: 'boom' },
  { kind: 'cancelled_by_engine', index: 2, childRunId: 'run-c', reason: 'fan_out_gate' },
  { kind: 'cancelled_out_of_band', index: 3, childRunId: 'run-d' },
  { kind: 'never_ran', index: 4, reason: 'unresolved_target', error: 'no such workflow' },
];

describe('parseFanOutReport (console mirror)', () => {
  test('parses a valid payload and derives the tally', () => {
    const report = parseFanOutReport({ children: mixed });
    expect(report).not.toBeNull();
    expect(report?.children).toHaveLength(5);
    expect(report?.tally.completed).toBe(1);
    expect(report?.tally.failed).toBe(1);
    expect(report?.tally.cancelledByEngine).toBe(1);
    expect(report?.tally.cancelledOutOfBand).toBe(1);
    expect(report?.tally.neverRan).toBe(1);
    expect(report?.tally.notCompleted).toBe(4);
  });

  test('legacy boolean fan_out: true parses to null', () => {
    expect(parseFanOutReport(true)).toBeNull();
  });

  test('garbage / malformed payloads parse to null', () => {
    expect(parseFanOutReport(undefined)).toBeNull();
    expect(parseFanOutReport(null)).toBeNull();
    expect(parseFanOutReport({})).toBeNull();
    expect(parseFanOutReport({ children: 'nope' })).toBeNull();
    // A single malformed slot rejects the whole report (no partial reconstruction).
    expect(parseFanOutReport({ children: [{ kind: 'completed', index: 0 }] })).toBeNull();
    expect(parseFanOutReport({ children: [{ kind: 'bogus', index: 0 }] })).toBeNull();
    // never_ran with an unknown reason.
    expect(
      parseFanOutReport({
        children: [{ kind: 'never_ran', index: 0, reason: 'weird', error: 'x' }],
      })
    ).toBeNull();
  });

  test('an empty children array is a valid report', () => {
    const report = parseFanOutReport({ children: [] });
    expect(report).not.toBeNull();
    expect(report?.tally.total).toBe(0);
  });
});

describe('formatting (console mirror matches the engine strings)', () => {
  const failed = tallyChildDispositions([
    { kind: 'completed', index: 0, childRunId: 'a' },
    { kind: 'completed', index: 1, childRunId: 'b' },
    { kind: 'failed', index: 2, childRunId: 'c', error: 'boom' },
  ]);
  const neverRan = tallyChildDispositions([
    { kind: 'never_ran', index: 0, reason: 'unresolved_target', error: 'x' },
    { kind: 'never_ran', index: 1, reason: 'unresolved_target', error: 'x' },
    { kind: 'never_ran', index: 2, reason: 'unresolved_target', error: 'x' },
  ]);

  test('headline says "did not complete"', () => {
    expect(formatFanOutHeadline(failed)).toBe('1 of 3 children did not complete');
    expect(formatFanOutHeadline(neverRan)).toBe('3 of 3 children did not complete');
  });

  test('breakdown lists non-zero categories, cancels generic', () => {
    expect(formatFanOutBreakdown(failed)).toBe('2 completed, 1 failed');
    expect(formatFanOutBreakdown(neverRan)).toBe('3 never ran');
  });

  test('full tally combines headline and breakdown', () => {
    expect(formatFanOutTally(failed)).toBe(
      '1 of 3 children did not complete (2 completed, 1 failed)'
    );
  });

  test('indexed child lines carry the specific reason', () => {
    expect(
      formatChildDispositionLine({
        kind: 'never_ran',
        index: 0,
        reason: 'unresolved_target',
        error: "Unknown 'typo'.",
      })
    ).toBe("[0] never ran · Unknown 'typo'.");
    expect(
      formatChildDispositionLine({
        kind: 'cancelled_by_engine',
        index: 2,
        childRunId: 'abcdef1234',
        reason: 'fan_out_gate',
      })
    ).toBe('[2] cancelled (fan_out_gate) · abcdef12');
  });
});

describe('summarizeRunFanOut', () => {
  test('sums notCompleted/total across fan-out nodes, skipping nulls', () => {
    const a: FanOutReport = { children: [], tally: tallyChildDispositions(mixed) };
    const b: FanOutReport = {
      children: [],
      tally: tallyChildDispositions([{ kind: 'completed', index: 0, childRunId: 'z' }]),
    };
    const summary = summarizeRunFanOut([a, null, b]);
    expect(summary).toEqual({ notCompleted: 4, total: 6 });
  });

  test('returns null when there is no fan-out node on the run', () => {
    expect(summarizeRunFanOut([null, null])).toBeNull();
    expect(summarizeRunFanOut([])).toBeNull();
  });
});
