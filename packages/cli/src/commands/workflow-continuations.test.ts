import { beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { NativeScheduleConfig } from '../triggers/native-schedule';
function makeTestWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv' },
    id: 'run',
    workflow_name: 'test',
    conversation_id: 'conv',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'paused',
    outcome: null,
    completed_outcome: null,
    user_message: 'test',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
    ...overrides,
  };
}

const output: unknown[] = [];
const scan = mock<
  typeof import('@archon/core/workflows/continuation-resume').wakeDueWorkflowContinuations
>(async () => []);
const resume = mock<
  typeof import('@archon/core/workflows/continuation-host').resumeWorkflowContinuation
>(async () => ({ kind: 'not-accepted' }));
const getRun = mock(async () => makeTestWorkflowRun());
const signal = mock(async () => ({ signaled: true }));
const install = mock(async (_config: NativeScheduleConfig) => ({
  path: 'installed',
  log: 'log',
}));
const remove = mock(async (_target: { id: string }) => true);
mock.module('@archon/core/workflows/continuation-host', () => ({
  resumeWorkflowContinuation: resume,
}));
mock.module('@archon/core/workflows/continuation-resume', () => ({
  wakeDueWorkflowContinuations: scan,
}));
const drain = mock<
  typeof import('@archon/core/workflows/resource-start-host').drainResourceStartHost
>(async () => undefined);
const realResourceStartHost = await import('@archon/core/workflows/resource-start-host');
mock.module('@archon/core/workflows/resource-start-host', () => ({
  ...realResourceStartHost,
  drainResourceStartHost: drain,
}));
const getStartReceipt = mock(async (id: string) => ({
  // The second binding was recorded as unmatched: no host, nothing started.
  bindings: id === 'woken' ? [{ hostId: 'build-host' }, { hostId: null }] : [],
}));
const host = {
  deps: { store: { getWorkflowRun: getRun, getStartReceipt } },
  operations: { signalWorkflowWait: signal },
} as unknown as import('@archon/core/workflows/host-store').WorkflowHost;
const writeStdout = mock(async (value: string) => {
  output.push(JSON.parse(value));
});
mock.module('../utils/stdout', () => ({ writeStdout }));
const realNativeSchedule = await import('../triggers/native-schedule');
let fingerprint: string | undefined = 'engine';
mock.module('../utils/engine-fingerprint', () => ({ engineFingerprint: () => fingerprint }));
mock.module('../triggers/native-schedule', () => ({
  ...realNativeSchedule,
  installNativeSchedule: install,
  removeNativeSchedule: remove,
  inspectNativeSchedule: mock(async () => undefined),
}));

/** The command reads the host platform; wake scheduling is macOS-only. */
async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}
import { workflowContinuationCommand, workflowWakeScheduleCommand } from './workflow-continuations';

beforeEach(() => {
  output.length = 0;
  fingerprint = 'engine';
  scan.mockReset();
  scan.mockResolvedValue([]);
  resume.mockReset();
  resume.mockResolvedValue({ kind: 'not-accepted' });
  getRun.mockReset();
  writeStdout.mockClear();
  signal.mockClear();
  install.mockClear();
  remove.mockClear();
  drain.mockReset();
  drain.mockResolvedValue(undefined);
});

test('empty wake succeeds and rejects fresh execution flags before scanning', async () => {
  expect(await workflowContinuationCommand(host, 'wake', [], { json: true })).toBe(0);
  expect(output[0]).toMatchObject({ ok: true, accepted: 0 });
  for (const flags of [
    { model: ['fast=x'] },
    { input: ['a=b'] },
    { container: true },
    { config: 'file' },
  ]) {
    expect(await workflowContinuationCommand(host, 'wake', [], { json: true, ...flags })).toBe(1);
  }
  expect(scan).toHaveBeenCalledTimes(1);
});

test('invalid payload, timestamp, extra positionals and stale event never mutate', async () => {
  const values = { json: true, event: 'ready', 'resume-at': '2026-08-24T11:00:00.000Z' };
  expect(await workflowContinuationCommand(host, 'signal', ['id'], { ...values, data: '{' })).toBe(
    1
  );
  expect(
    await workflowContinuationCommand(host, 'signal', ['id'], { ...values, 'resume-at': 'today' })
  ).toBe(1);
  expect(await workflowContinuationCommand(host, 'signal', ['id', 'extra'], values)).toBe(1);
  expect(await workflowContinuationCommand(host, 'signal', ['id'], { ...values, event: '' })).toBe(
    1
  );
  expect(await workflowContinuationCommand(host, 'signal', ['id'], { ...values, event: 123 })).toBe(
    1
  );
  expect(getRun).not.toHaveBeenCalled();
  getRun.mockResolvedValue(makeTestWorkflowRun({ status: 'paused', metadata: {} }));
  expect(await workflowContinuationCommand(host, 'signal', ['id'], values)).toBe(1);
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
  expect(await workflowContinuationCommand(host, 'wake', [], { json: true })).toBe(1);
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

test('a handed-off continuation is reported with its observed status, not as completed', async () => {
  scan.mockResolvedValue([
    {
      runId: 'live',
      kind: 'accepted',
      run: makeTestWorkflowRun(),
      settled: Promise.resolve({
        success: true,
        handedOff: true,
        workflowRunId: 'live',
        observedStatus: 'running',
      }),
    },
    {
      runId: 'gone',
      kind: 'accepted',
      run: makeTestWorkflowRun(),
      settled: Promise.resolve({
        success: false,
        handedOff: true,
        workflowRunId: 'gone',
        observedStatus: 'cancelled',
        error: 'run was cancelled',
      }),
    },
  ]);
  expect(await workflowContinuationCommand(host, 'wake', [], { json: true })).toBe(1);
  expect(output[0]).toMatchObject({
    ok: false,
    outcomes: [
      { runId: 'live', status: 'handed_off', observedStatus: 'running' },
      { runId: 'gone', status: 'failed', error: 'run was cancelled' },
    ],
  });
});

test('a continuation refused for capacity is reported as what it is and the pass succeeds', async () => {
  scan.mockResolvedValue([
    {
      runId: 'full',
      kind: 'waiting_for_capacity',
      blocker: { kind: 'run', id: 'holder' },
      message: 'busy',
    },
    {
      runId: 'quota',
      kind: 'resource_busy',
      blocker: { kind: 'request', id: 'queued' },
      refusal: 'failed',
      message: 'busy',
    },
  ]);
  expect(await workflowContinuationCommand(host, 'wake', [], { json: true })).toBe(0);
  expect(output[0]).toMatchObject({
    ok: true,
    accepted: 0,
    outcomes: [
      { runId: 'full', kind: 'waiting_for_capacity', blocker: { id: 'holder' } },
      { runId: 'quota', kind: 'resource_busy', refusal: 'failed', blocker: { id: 'queued' } },
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
  const command = workflowContinuationCommand(host, 'wake', [], { json: true, watch: true }).then(
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

test('schedule validates intervals and removes the exact installed identity', () =>
  onPlatform('darwin', async () => {
    for (const interval of ['0', '-1', '1.5', 'no']) {
      expect(
        await workflowWakeScheduleCommand(['schedule', 'install'], {
          json: true,
          interval,
        })
      ).toBe(1);
    }
    expect(install).not.toHaveBeenCalled();
    expect(
      await workflowWakeScheduleCommand(['schedule', 'install'], {
        json: true,
        interval: '10',
      })
    ).toBe(0);
    expect(await workflowWakeScheduleCommand(['schedule', 'remove'], { json: true })).toBe(0);
    const config = install.mock.calls[0]?.[0];
    expect(remove.mock.calls[0]?.[0].id).toBe(config?.id);
    expect(config).toMatchObject({
      id: expect.stringContaining('workflow-wake-'),
      schedule: { intervalSeconds: 10, runAtLoad: true },
      output: 'discard',
      programArguments: expect.arrayContaining(['workflow', 'wake', '--watch', '--json']),
    });
  }));

test('schedule installation failure is reported with a nonzero exit', () =>
  onPlatform('darwin', async () => {
    install.mockRejectedValueOnce(new Error('service not registered'));
    expect(await workflowWakeScheduleCommand(['schedule', 'install'], { json: true })).toBe(1);
    expect(output[0]).toMatchObject({ ok: false, error: 'service not registered' });
  }));

test('schedule refuses to install a wake timer off macOS', () =>
  onPlatform('linux', async () => {
    expect(await workflowWakeScheduleCommand(['schedule', 'install'], { json: true })).toBe(1);
    expect(install).not.toHaveBeenCalled();
    expect(output[0]).toMatchObject({ ok: false });
  }));

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
    expect(await workflowContinuationCommand(host, 'wake', [], { json: true, watch: true })).toBe(
      1
    );
    expect(scan).toHaveBeenCalledTimes(2);
    expect(output).toEqual([
      { ok: false, action: 'wake', error: 'database unavailable' },
      { ok: true, action: 'wake', accepted: 0, outcomes: [] },
    ]);
  } finally {
    timer.mockRestore();
  }
});

test('watch exits 75 before its next pass when the installed engine changed', async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation((callback: () => void) =>
    originalTimeout(callback, 0)
  );
  fingerprint = 'a';
  scan.mockImplementationOnce(async () => {
    fingerprint = 'b';
    return [];
  });
  // Ends the loop if the check misses the change, so the failure is an assertion, not a hang.
  scan.mockImplementationOnce(async () => {
    process.emit('SIGTERM');
    return [];
  });
  try {
    expect(await workflowContinuationCommand(host, 'wake', [], { json: true, watch: true })).toBe(
      75
    );
    expect(scan).toHaveBeenCalledTimes(1);
    expect(output.at(-1)).toEqual({
      ok: true,
      action: 'wake',
      restart: 'engine changed',
      loaded: 'a',
      current: 'b',
    });
  } finally {
    timer.mockRestore();
  }
});

test.each(['occurrence', 'deadline', 'both'])(
  'signal with %s passes its selectors as the local operator and rejects a CAS loser',
  async selector => {
    const wait = {
      owner: 'node' as const,
      nodeId: 'hold',
      kind: 'event' as const,
      pauseId: 'event-occurrence',
      event: 'ready',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2099-08-24T11:00:00.000Z',
    };
    getRun.mockResolvedValue(makeTestWorkflowRun({ metadata: { wait } }));
    signal.mockResolvedValueOnce({ signaled: false });
    const values = {
      json: true,
      event: wait.event,
      ...(selector !== 'deadline' ? { occurrence: wait.pauseId } : {}),
      ...(selector !== 'occurrence' ? { 'resume-at': wait.resumeAt } : {}),
      data: '{"ready":true}',
    };
    expect(await workflowContinuationCommand(host, 'signal', ['run'], values)).toBe(1);
    expect(signal).toHaveBeenCalledWith(
      'run',
      {
        event: wait.event,
        ...(selector !== 'deadline' ? { occurrence: wait.pauseId } : {}),
        ...(selector !== 'occurrence' ? { resumeAt: wait.resumeAt } : {}),
        payload: { ready: true },
      },
      {
        kind: 'operator',
      }
    );
    expect(resume).not.toHaveBeenCalled();
    signal.mockResolvedValueOnce({ signaled: true });
    expect(await workflowContinuationCommand(host, 'signal', ['run'], values)).toBe(0);
    expect(resume).toHaveBeenCalledWith(
      host,
      'run',
      expect.any(Function),
      {
        kind: 'wait',
        pauseId: wait.pauseId,
        nodeId: wait.nodeId,
        resumeAt: wait.resumeAt,
      },
      undefined,
      { deferScratchCleanup: undefined }
    );
  }
);

test('a stale occurrence with an equal deadline never signals or resumes', async () => {
  const wait = {
    owner: 'node' as const,
    nodeId: 'hold',
    kind: 'event' as const,
    pauseId: 'second',
    event: 'ready',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2099-08-24T11:00:00.000Z',
  };
  getRun.mockResolvedValue(makeTestWorkflowRun({ metadata: { wait } }));
  expect(
    await workflowContinuationCommand(host, 'signal', ['run'], {
      json: true,
      event: wait.event,
      occurrence: 'first',
      'resume-at': wait.resumeAt,
    })
  ).toBe(1);
  expect(signal).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

test('SIGTERM wakes installed idle sleep without firing its timer or scanning again', async () => {
  const installed = Promise.withResolvers<void>();
  const originalTimeout = globalThis.setTimeout;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let fireIdleTimer: (() => void) | undefined;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation(callback => {
    fireIdleTimer = callback;
    idleTimer = originalTimeout(callback, 5_000);
    installed.resolve();
    return idleTimer;
  });
  let done = false;
  const command = workflowContinuationCommand(host, 'wake', [], { json: true, watch: true }).then(
    result => {
      done = true;
      return result;
    }
  );
  try {
    await installed.promise;
    process.emit('SIGTERM');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(done).toBe(true);
    expect(await command).toBe(0);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(timer).toHaveBeenCalledTimes(1);
  } finally {
    timer.mockRestore();
    if (idleTimer) clearTimeout(idleTimer);
    process.emit('SIGTERM');
    fireIdleTimer?.();
    await command;
  }
});

test.each([false, true])(
  'watch reports settled outcome before draining cleanup on shutdown (failed=%p)',
  async failed => {
    const started = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    let done = false;
    resume.mockImplementationOnce(async (_host, _runId, _context, _cursor, _actor, options) => {
      if (!options?.deferScratchCleanup) throw new Error('Cleanup must be deferred');
      options.deferScratchCleanup(async () => {
        process.emit('SIGTERM');
        started.resolve();
        await drained.promise;
      });
      return {
        kind: 'accepted',
        run: makeTestWorkflowRun(),
        settled: Promise.resolve(
          failed
            ? { success: false, error: 'DAG failed', workflowRunId: 'run' }
            : { success: true, workflowRunId: 'run' }
        ),
      };
    });
    scan.mockImplementationOnce(async (_store, _now, admit) => [
      {
        runId: 'run',
        ...(await admit(makeTestWorkflowRun(), {
          kind: 'wait',
          pauseId: 'wait',
          nodeId: 'hold',
          resumeAt: '2026-08-24T11:00:00Z',
        })),
      },
    ]);
    const command = workflowContinuationCommand(host, 'wake', [], { json: true, watch: true }).then(
      result => {
        done = true;
        return result;
      }
    );
    try {
      await started.promise;
      expect(output[0]).toMatchObject({
        ok: !failed,
        accepted: 1,
        outcomes: [{ status: failed ? 'failed' : 'completed' }],
      });
      expect(done).toBe(false);
    } finally {
      drained.resolve();
    }
    expect(await command).toBe(failed ? 1 : 0);
    expect(scan).toHaveBeenCalledTimes(1);
  }
);

test('a failed accepted report still drains cleanup and fails the wake', async () => {
  const cleanup = mock(async () => {});
  resume.mockImplementationOnce(async (_host, _runId, _context, _cursor, _actor, options) => {
    options?.deferScratchCleanup?.(cleanup);
    return {
      kind: 'accepted',
      run: makeTestWorkflowRun(),
      settled: Promise.resolve({ success: true, workflowRunId: 'run' }),
    };
  });
  scan.mockImplementationOnce(async (_store, _now, admit) => [
    {
      runId: 'run',
      ...(await admit(makeTestWorkflowRun(), {
        kind: 'wait',
        pauseId: 'wait',
        nodeId: 'hold',
        resumeAt: '2026-08-24T11:00:00Z',
      })),
    },
  ]);
  writeStdout.mockImplementationOnce(async () => {
    throw new Error('stdout closed');
  });
  expect(await workflowContinuationCommand(host, 'wake', [], { json: true })).toBe(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(output).toEqual([{ ok: false, action: 'wake', error: 'stdout closed' }]);
});

function observation(receipts: string[]) {
  const dispatch = mock(async () => null);
  const unserved = [
    {
      wait: { workflowName: 'host', event: 'review', about: 'abc', itemKey: 'issue-3' },
      reason: "item 'issue-3' names no pull request under the binding's item mapping",
    },
  ];
  const pass = mock(async () => [
    { source: 'github', waits: 2, reads: 1, receipts, conflicts: 0, unserved },
  ]);
  return {
    dispatch,
    pass,
    unserved,
    value: {
      observer: { observing: [{ sourceInstanceId: 'github', everySeconds: 60 }], pass },
      dispatch,
    },
  };
}

test('watch says what it observes, and starts what an observed wait admitted on its host', async () => {
  const observed = observation(['woken', 'unmatched']);
  drain.mockImplementation(async drained => {
    await drained.startAdmitted('request-1');
  });
  scan.mockImplementationOnce(async () => {
    process.emit('SIGTERM');
    return [];
  });
  expect(
    await workflowContinuationCommand(
      host,
      'wake',
      [],
      { json: true, watch: true },
      async () => observed.value
    )
  ).toBe(0);
  expect(output[0]).toEqual({
    ok: true,
    action: 'wake',
    observe: [{ source: 'github', everySeconds: 60 }],
  });
  // The observation loop runs beside the continuation pass, so its line has no fixed place.
  expect(output.find(line => (line as { action?: string }).action === 'observe')).toEqual({
    ok: true,
    action: 'observe',
    source: 'github',
    waits: 2,
    reads: 1,
    started: 1,
    conflicts: 0,
    unserved: observed.unserved,
  });
  expect(drain.mock.calls.map(([drained]) => drained.hostId)).toEqual(['build-host']);
  expect(observed.dispatch).toHaveBeenCalledWith('request-1', 'build-host');
});

test('a host whose drain failed is drained again on the next pass, with no new observation', async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation((callback: () => void) =>
    originalTimeout(callback, 0)
  );
  const observed = observation(['woken']);
  // The wait closed when its receipt was recorded, so the next pass observes nothing; the
  // third observation pass stops the watch.
  observed.pass
    .mockImplementationOnce(async () => [
      { source: 'github', waits: 1, reads: 1, receipts: ['woken'], conflicts: 0, unserved: [] },
    ])
    .mockImplementationOnce(async () => [])
    .mockImplementation(async () => {
      process.emit('SIGTERM');
      return [];
    });
  drain.mockRejectedValueOnce(new Error('database unavailable'));
  try {
    expect(
      await workflowContinuationCommand(
        host,
        'wake',
        [],
        { json: true, watch: true },
        async () => observed.value
      )
    ).toBe(1);
    expect(output).toContainEqual({
      ok: false,
      action: 'observe',
      drain: 'build-host',
      error: "host 'build-host' drain failed: database unavailable",
      hint: 'A running watch retries it on its next pass; otherwise run archon trigger drain --host build-host.',
    });
    expect(drain.mock.calls.map(([drained]) => drained.hostId)).toEqual([
      'build-host',
      'build-host',
    ]);
  } finally {
    timer.mockRestore();
  }
});

test('watch keeps observing at its interval while a resumed run is still running', async () => {
  const originalTimeout = globalThis.setTimeout;
  const timers: {
    setTimeout(callback: () => void, delay?: number): ReturnType<typeof setTimeout>;
  } = globalThis;
  const timer = spyOn(timers, 'setTimeout').mockImplementation((callback: () => void) =>
    originalTimeout(callback, 0)
  );
  let finish!: (value: { success: true; workflowRunId: string }) => void;
  const settled = new Promise<{ success: true; workflowRunId: string }>(resolve => {
    finish = resolve;
  });
  scan.mockImplementationOnce(async () => [
    { runId: 'long', kind: 'accepted', run: makeTestWorkflowRun(), settled },
  ]);
  const observed = observation([]);
  let passes = 0;
  // The resumed run ends only once three observation passes have run beside it.
  observed.pass.mockImplementation(async () => {
    passes += 1;
    if (passes === 3) {
      finish({ success: true, workflowRunId: 'long' });
      process.emit('SIGTERM');
    }
    return [];
  });
  try {
    expect(
      await workflowContinuationCommand(
        host,
        'wake',
        [],
        { json: true, watch: true },
        async () => observed.value
      )
    ).toBe(0);
    expect(passes).toBe(3);
    expect(output).toContainEqual(
      expect.objectContaining({
        action: 'wake',
        outcomes: [expect.objectContaining({ runId: 'long', status: 'completed' })],
      })
    );
  } finally {
    timer.mockRestore();
  }
});
