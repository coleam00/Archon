import { beforeEach, expect, mock, test } from 'bun:test';
import type {
  ContinuationWakeOutcome,
  ContinuationAdmission,
} from '@archon/core/workflows/continuation-host';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { NativeScheduleConfig } from '../triggers/native-schedule';
function makeTestWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run',
    workflow_name: 'test',
    conversation_id: 'conv',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'paused',
    outcome: null,
    user_message: 'test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

const output: unknown[] = [];
const scan = mock(async (): Promise<ContinuationWakeOutcome[]> => []);
const resume = mock(async (): Promise<ContinuationAdmission> => ({ kind: 'not-accepted' }));
const getRun = mock(async () => makeTestWorkflowRun());
const signal = mock(async () => ({ signaled: true }));
const install = mock(async (_config: NativeScheduleConfig) => 'installed');
const remove = mock(async (_id: string) => true);
mock.module('@archon/core/workflows/continuation-host', () => ({
  wakeDueWorkflowContinuations: scan,
  resumeWorkflowContinuation: resume,
}));
mock.module('@archon/core/db/workflows', () => ({
  getWorkflowRun: getRun,
  signalWorkflowWait: signal,
}));
mock.module('../utils/stdout', () => ({
  writeStdout: async (value: string) => {
    output.push(JSON.parse(value));
  },
}));
mock.module('../triggers/native-schedule', () => ({
  installMacosNativeSchedule: install,
  removeMacosNativeSchedule: remove,
}));
import { workflowContinuationCommand } from './workflow-continuations';

beforeEach(() => {
  output.length = 0;
  scan.mockReset();
  scan.mockResolvedValue([]);
  resume.mockReset();
  resume.mockResolvedValue({ kind: 'not-accepted' });
  getRun.mockReset();
  signal.mockClear();
  install.mockClear();
  remove.mockClear();
});

test('empty wake succeeds and rejects fresh execution flags before scanning', async () => {
  expect(await workflowContinuationCommand('wake', [], { json: true })).toBe(0);
  expect(output[0]).toMatchObject({ ok: true, accepted: 0 });
  for (const flags of [
    { model: ['fast=x'] },
    { input: ['a=b'] },
    { container: true },
    { config: 'file' },
  ]) {
    expect(await workflowContinuationCommand('wake', [], { json: true, ...flags })).toBe(1);
  }
  expect(scan).toHaveBeenCalledTimes(1);
});

test('invalid payload, timestamp, extra positionals and stale event never mutate', async () => {
  const values = { json: true, event: 'ready', 'resume-at': '2026-08-24T11:00:00.000Z' };
  expect(await workflowContinuationCommand('signal', ['id'], { ...values, data: '{' })).toBe(1);
  expect(
    await workflowContinuationCommand('signal', ['id'], { ...values, 'resume-at': 'today' })
  ).toBe(1);
  expect(await workflowContinuationCommand('signal', ['id', 'extra'], values)).toBe(1);
  expect(await workflowContinuationCommand('signal', ['id'], { ...values, event: '' })).toBe(1);
  expect(await workflowContinuationCommand('signal', ['id'], { ...values, event: 123 })).toBe(1);
  expect(getRun).not.toHaveBeenCalled();
  getRun.mockResolvedValue(makeTestWorkflowRun({ status: 'paused', metadata: {} }));
  expect(await workflowContinuationCommand('signal', ['id'], values)).toBe(1);
  expect(signal).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test('reports refusal, deferral and settlement failures instead of admission-only success', async () => {
  scan.mockResolvedValue([
    { runId: 'refused', kind: 'unavailable', reason: 'container' },
    { runId: 'defer', kind: 'not-accepted', deferError: new Error('database unavailable') },
    {
      runId: 'execute',
      kind: 'accepted',
      run: makeTestWorkflowRun(),
      settled: Promise.resolve({ success: false, error: 'bash failed' }),
    },
  ]);
  expect(await workflowContinuationCommand('wake', [], { json: true })).toBe(1);
  expect(output[0]).toMatchObject({
    ok: false,
    accepted: 1,
    outcomes: [
      { runId: 'refused', reason: 'container' },
      { runId: 'defer', deferError: 'database unavailable' },
      { runId: 'execute', status: 'failed', error: 'bash failed' },
    ],
  });
});

test('watch drains accepted segments on shutdown', async () => {
  let finish!: (value: { success: true; workflowRunId: string }) => void;
  const settled = new Promise<{ success: true; workflowRunId: string }>(resolve => {
    finish = resolve;
  });
  scan.mockImplementationOnce(async () => {
    process.emit('SIGTERM');
    return [{ runId: 'running', kind: 'accepted', run: makeTestWorkflowRun(), settled }];
  });
  let done = false;
  const command = workflowContinuationCommand('wake', [], { json: true, watch: true }).then(
    result => {
      done = true;
      return result;
    }
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  finish({ success: true, workflowRunId: 'running' });
  expect(await command).toBe(0);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(output[0]).toMatchObject({ outcomes: [{ status: 'completed' }] });
});

test('schedule validates intervals and removes the exact installed identity', async () => {
  for (const interval of ['0', '-1', '1.5', 'no']) {
    expect(
      await workflowContinuationCommand('wake', ['schedule', 'install'], { json: true, interval })
    ).toBe(1);
  }
  expect(install).not.toHaveBeenCalled();
  expect(
    await workflowContinuationCommand('wake', ['schedule', 'install'], {
      json: true,
      interval: '10',
    })
  ).toBe(0);
  expect(await workflowContinuationCommand('wake', ['schedule', 'remove'], { json: true })).toBe(0);
  const config = install.mock.calls[0]?.[0];
  expect(remove.mock.calls[0]?.[0]).toBe(config?.id);
  expect(config).toMatchObject({
    id: expect.stringContaining('workflow-wake-'),
    schedule: { intervalSeconds: 10, runAtLoad: true },
  });
});

test('schedule installation failure is reported with a nonzero exit', async () => {
  install.mockRejectedValueOnce(new Error('service not registered'));
  expect(await workflowContinuationCommand('wake', ['schedule', 'install'], { json: true })).toBe(
    1
  );
  expect(output[0]).toMatchObject({ ok: false, error: 'service not registered' });
});

test('watch continues after a failed pass and returns failure on shutdown', async () => {
  const { spyOn } = await import('bun:test');
  const originalTimeout = globalThis.setTimeout;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation((callback: () => void) =>
    originalTimeout(callback, 0)
  );
  scan.mockRejectedValueOnce(new Error('database unavailable'));
  scan.mockImplementationOnce(async () => {
    process.emit('SIGTERM');
    return [];
  });
  try {
    expect(await workflowContinuationCommand('wake', [], { json: true, watch: true })).toBe(1);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(output).toEqual([
      { ok: false, action: 'wake', error: 'database unavailable' },
      { ok: true, action: 'wake', accepted: 0, outcomes: [] },
    ]);
  } finally {
    timer.mockRestore();
  }
});
