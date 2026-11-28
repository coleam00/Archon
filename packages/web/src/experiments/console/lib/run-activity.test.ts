import { describe, expect, test } from 'bun:test';
import type { Run } from '../primitives/run';
import { lastActivityLabel, QUIET_AFTER_MS, quietMinutes, runQuietMs } from './run-activity';

type Progress = NonNullable<Run['progress']>;

const now = Date.parse('2026-11-27T12:00:00.000Z');
const observed = (msAgo: number): string => new Date(now - msAgo).toISOString();

function progress(msAgo: number, silentByDesign = false): Progress {
  return {
    steps: [],
    silent_by_design: silentByDesign,
    last_observed_at: observed(msAgo),
    last_message: null,
    branch: null,
    base_branch: null,
  };
}

const HOUR = 60 * 60_000;

describe('runQuietMs', () => {
  test('flags a running run once it has recorded nothing for the threshold, not before', () => {
    const run = (msAgo: number) => ({ status: 'running' as const, progress: progress(msAgo) });
    expect(runQuietMs(run(QUIET_AFTER_MS - 1), now)).toBeNull();
    expect(runQuietMs(run(QUIET_AFTER_MS), now)).toBe(10 * 60_000);
    expect(runQuietMs(run(HOUR), now)).toBe(HOUR);
  });

  test('never flags a paused run, a run whose owner is not live, or one without progress', () => {
    const quiet = progress(HOUR);
    expect(runQuietMs({ status: 'paused', progress: quiet }, now)).toBeNull();
    expect(
      runQuietMs({ status: 'running', ownerObservation: 'unreachable', progress: quiet }, now)
    ).toBeNull();
    expect(runQuietMs({ status: 'running', progress: null }, now)).toBeNull();
    expect(
      runQuietMs({ status: 'running', progress: { ...quiet, last_observed_at: null } }, now)
    ).toBeNull();
  });

  test('never flags a run the server calls silent by design', () => {
    expect(runQuietMs({ status: 'running', progress: progress(HOUR, true) }, now)).toBeNull();
  });
});

test('the activity label counts whole minutes and says "just now" under one', () => {
  expect(lastActivityLabel(observed(0), now)).toBe('active just now');
  expect(lastActivityLabel(observed(59_000), now)).toBe('active just now');
  expect(lastActivityLabel(observed(4 * 60_000 + 30_000), now)).toBe('active 4m ago');
  expect(quietMinutes(11 * 60_000 + 59_000)).toBe(11);
});
