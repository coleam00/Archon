import { describe, it, expect, mock } from 'bun:test';

// --- Mock logger (must come before module-under-test imports) ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import {
  startWorkflowHeartbeat,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type HeartbeatEmitter,
} from './workflow-heartbeat';
import type { WorkflowEmitterEvent } from './event-emitter';
import type { IWorkflowPlatform } from './deps';

// ---------------------------------------------------------------------------
// In-test emitter — avoids depending on the singleton, which other test
// files in the same Bun process can clobber via `mock.module('./event-emitter')`.
// ---------------------------------------------------------------------------

type LocalEmitter = HeartbeatEmitter & { emit: (e: WorkflowEmitterEvent) => void };

function makeLocalEmitter(): LocalEmitter {
  const listeners = new Set<(e: WorkflowEmitterEvent) => void>();
  return {
    emit(event) {
      for (const l of listeners) l(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

function makeFakeClock(initial = 1_000_000): FakeClock {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface FakeTimer {
  cleared: boolean;
  intervalMs: number;
}

interface FakeScheduler {
  setInterval: (fn: () => void, ms: number) => FakeTimer;
  clearInterval: (handle: FakeTimer) => void;
  timer: FakeTimer | undefined;
}

function makeFakeScheduler(): FakeScheduler {
  let timer: FakeTimer | undefined;
  return {
    get timer() {
      return timer;
    },
    setInterval: (_fn, ms) => {
      const t: FakeTimer = { cleared: false, intervalMs: ms };
      timer = t;
      return t;
    },
    clearInterval: (handle: FakeTimer) => {
      handle.cleared = true;
    },
  };
}

function makeFakePlatform(platformType: string): {
  platform: IWorkflowPlatform;
  sent: Array<{ conversationId: string; message: string; metadata?: unknown }>;
  failNext: () => void;
} {
  const sent: Array<{ conversationId: string; message: string; metadata?: unknown }> = [];
  let shouldFail = false;
  const platform: IWorkflowPlatform = {
    async sendMessage(conversationId, message, metadata) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('platform unavailable');
      }
      sent.push({ conversationId, message, metadata });
    },
    getStreamingMode: () => 'batch',
    getPlatformType: () => platformType,
  };
  return {
    platform,
    sent,
    failNext: () => {
      shouldFail = true;
    },
  };
}

/** Common fixture builder — returns everything a test usually needs. */
function setup(platformType: string) {
  const clock = makeFakeClock();
  const scheduler = makeFakeScheduler();
  const emitter = makeLocalEmitter();
  const { platform, sent, failNext } = makeFakePlatform(platformType);

  const start = (intervalMs = 60_000) =>
    startWorkflowHeartbeat({
      runId: 'run-1',
      platform,
      conversationId: 'conv-1',
      intervalMs,
      emitter,
      now: clock.now,
      setInterval: scheduler.setInterval as unknown as typeof setInterval,
      clearInterval: scheduler.clearInterval as unknown as typeof clearInterval,
    });

  return { clock, scheduler, emitter, platform, sent, failNext, start };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow-heartbeat', () => {
  it('is a no-op for non-chat platforms', () => {
    const { scheduler, sent, start } = setup('web');
    const handle = start();
    expect(scheduler.timer).toBeUndefined();
    expect(sent).toHaveLength(0);
    handle.stop();
  });

  it('skips nodes that are younger than the heartbeat interval', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(30_000);
    await handle.tick();
    expect(sent).toHaveLength(0);
    handle.stop();
  });

  it('posts a heartbeat for a node that crosses the interval threshold', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(65_000);
    await handle.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.conversationId).toBe('conv-1');
    expect(sent[0]!.message).toContain('implement');
    expect(sent[0]!.message).toContain('Still working');
    expect((sent[0]!.metadata as { category?: string }).category).toBe('workflow_status');
    handle.stop();
  });

  it('includes last tool call when available', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(40_000);
    emitter.emit({ type: 'tool_started', runId: 'run-1', toolName: 'Edit', stepName: 'implement' });
    clock.advance(30_000);
    await handle.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('last tool: Edit');
    handle.stop();
  });

  it('does not post heartbeats for other runs', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-OTHER',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(120_000);
    await handle.tick();
    expect(sent).toHaveLength(0);
    handle.stop();
  });

  it('stops posting once a node completes', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(65_000);
    await handle.tick();
    expect(sent).toHaveLength(1);

    emitter.emit({
      type: 'node_completed',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
      duration: 65_000,
    });
    clock.advance(120_000);
    await handle.tick();
    expect(sent).toHaveLength(1);
    handle.stop();
  });

  it('consolidates multiple parallel nodes into one message', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'review-correctness',
      nodeName: 'review-correctness',
    });
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'review-security',
      nodeName: 'review-security',
    });
    clock.advance(90_000);
    await handle.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain('review-correctness');
    expect(sent[0]!.message).toContain('review-security');
    handle.stop();
  });

  it('re-pings on subsequent ticks for still-running nodes', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({ type: 'node_started', runId: 'run-1', nodeId: 'ci-wait', nodeName: 'ci-wait' });
    clock.advance(65_000);
    await handle.tick();
    expect(sent).toHaveLength(1);

    clock.advance(65_000);
    await handle.tick();
    expect(sent).toHaveLength(2);
    handle.stop();
  });

  it('suppresses re-ping that would occur within the interval window', async () => {
    const { clock, sent, emitter, start } = setup('slack');
    const handle = start();
    emitter.emit({ type: 'node_started', runId: 'run-1', nodeId: 'ci-wait', nodeName: 'ci-wait' });
    clock.advance(65_000);
    await handle.tick();
    expect(sent).toHaveLength(1);

    clock.advance(10_000);
    await handle.tick();
    expect(sent).toHaveLength(1);
    handle.stop();
  });

  it('swallows platform send errors so the workflow is not affected', async () => {
    const { clock, sent, emitter, failNext, start } = setup('slack');
    const handle = start();
    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(65_000);
    failNext();
    await expect(handle.tick()).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    handle.stop();
  });

  it('stop() clears the timer and unsubscribes from events', async () => {
    const { clock, scheduler, sent, emitter, start } = setup('slack');
    const handle = start();
    handle.stop();
    expect(scheduler.timer?.cleared).toBe(true);

    emitter.emit({
      type: 'node_started',
      runId: 'run-1',
      nodeId: 'implement',
      nodeName: 'implement',
    });
    clock.advance(120_000);
    await handle.tick();
    expect(sent).toHaveLength(0);
  });

  it('stop() is idempotent', () => {
    const { start } = setup('slack');
    const handle = start();
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  it('emits for discord and telegram as well as slack', () => {
    for (const platformType of ['discord', 'telegram']) {
      const { scheduler, start } = setup(platformType);
      const handle = start();
      expect(scheduler.timer).toBeDefined();
      handle.stop();
    }
  });

  it('exposes a sensible default interval', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });
});
