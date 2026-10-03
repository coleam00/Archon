import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { wakeDueWorkflowContinuations } from '@archon/core/workflows/continuation-host';
const scan = mock<typeof wakeDueWorkflowContinuations>(async () => []);
mock.module('@archon/core/workflows/continuation-host', () => ({
  wakeDueWorkflowContinuations: scan,
  resumeWorkflowContinuation: mock(async () => ({ kind: 'not-accepted' })),
}));
import {
  startWorkflowContinuationScheduler,
  stopWorkflowContinuationScheduler,
} from './workflow-resume-service';
afterEach(() => {
  stopWorkflowContinuationScheduler();
  mock.restore();
});

test('delegates immediately, guards overlap, ticks other host work and stops the interval', async () => {
  let release!: () => void;
  scan.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return [];
  });
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation((callback: () => void) => {
    tick = callback;
    return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
  });
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
  const otherHostWork = mock(() => undefined);
  startWorkflowContinuationScheduler(undefined, otherHostWork);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(interval.mock.calls[0]?.[1]).toBe(5000);
  tick?.();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(otherHostWork).toHaveBeenCalledTimes(2);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  tick?.();
  expect(scan).toHaveBeenCalledTimes(2);
  stopWorkflowContinuationScheduler();
  expect(clear).toHaveBeenCalledTimes(1);
});
