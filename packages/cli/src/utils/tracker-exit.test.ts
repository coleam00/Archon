import { expect, test } from 'bun:test';
import { markTrackerPassOwed, syncTrackerIfOwed } from './tracker-exit';

test('a process that changed no run makes no tracker pass', async () => {
  let calls = 0;
  await syncTrackerIfOwed({}, async () => {
    calls++;
  });
  expect(calls).toBe(0);
});

test('a tracker pass that fails does not fail the command, and runs once', async () => {
  let calls = 0;
  const failing = async (): Promise<never> => {
    calls++;
    throw new Error('forge unreachable');
  };
  markTrackerPassOwed();
  await syncTrackerIfOwed({}, failing);
  await syncTrackerIfOwed({}, failing);
  expect(calls).toBe(1);
});
