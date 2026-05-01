import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { Orchestrator } from './orchestrator';
import { buildSnapshot, type ConfigSnapshot } from '../config/snapshot';
import { makeFakeTracker, makeIssue } from '../test/fake-tracker';
import {
  makeFakeBridge,
  makeFakeEmitter,
  makeFakeWorkflowDefinition,
  type FakeBridge,
  type FakeEmitter,
} from '../test/fake-bridge';
import type { SymphonyEmitterEvent } from '../event-emitter';
import { buildDispatchKey } from './state';

let dbPath = '';
let db: SqliteAdapter;
let fakeBridge: FakeBridge;
let workflowEmitter: FakeEmitter;

function snap(): ConfigSnapshot {
  return buildSnapshot(
    {
      trackers: [
        {
          kind: 'linear',
          api_key: '$K',
          project_slug: 's',
          repository: 'Ddell12/archon-symphony',
          active_states: ['Todo'],
          terminal_states: ['Done'],
        },
      ],
      dispatch: { max_concurrent: 5 },
      polling: { interval_ms: 30_000 },
      state_workflow_map: { Todo: 'archon-feature-development' },
      codebases: [
        {
          tracker: 'linear',
          repository: 'Ddell12/archon-symphony',
          codebase_id: 'cb-1',
        },
      ],
    },
    { K: 'tok' } as NodeJS.ProcessEnv
  );
}

function makeRecorder(): {
  events: SymphonyEmitterEvent[];
  getEmitter: () => { emit: (e: SymphonyEmitterEvent) => void };
} {
  const events: SymphonyEmitterEvent[] = [];
  const emitter = {
    emit(event: SymphonyEmitterEvent) {
      events.push(event);
    },
  };
  return { events, getEmitter: () => emitter };
}

describe('Orchestrator emits SymphonyEmitterEvents at every state transition', () => {
  beforeEach(async () => {
    dbPath = join(
      import.meta.dir,
      `.test-symphony-emit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(dbPath);
    await db.query(
      'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
      ['cb-1', 'Codebase 1', '/tmp/cb-1']
    );
    workflowEmitter = makeFakeEmitter();
    fakeBridge = makeFakeBridge({
      db,
      codebases: new Map([['cb-1', { id: 'cb-1', name: 'Codebase 1', default_cwd: '/tmp/cb-1' }]]),
      workflows: {
        'archon-feature-development': makeFakeWorkflowDefinition('archon-feature-development'),
      },
    });
  });

  afterEach(async () => {
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  test('successful dispatch emits claimed → started → completed and tracker_poll_completed', async () => {
    const issue = makeIssue({ id: 'l-1', identifier: 'APP-1', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    const { events, getEmitter } = makeRecorder();
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => workflowEmitter,
      getSymphonyEmitter: getEmitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    orch.start();

    await orch.runTick();

    const dk = buildDispatchKey('linear', 'APP-1');
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');
    const runId = entry.workflow_run_id;

    workflowEmitter.emit({
      type: 'workflow_completed',
      runId,
      workflowName: 'archon-feature-development',
      duration: 12,
    });
    await new Promise(r => setTimeout(r, 10));

    const types = events.map(e => e.type);
    expect(types).toContain('tracker_poll_completed');
    expect(types).toContain('dispatch_claimed');
    expect(types).toContain('dispatch_started');
    expect(types).toContain('dispatch_completed');

    const claimed = events.find(e => e.type === 'dispatch_claimed');
    expect(claimed && claimed.type === 'dispatch_claimed' && claimed.dispatchKey).toBe(dk);
    const started = events.find(e => e.type === 'dispatch_started');
    expect(started && started.type === 'dispatch_started' && started.workflowRunId).toBe(runId);
    expect(started && started.type === 'dispatch_started' && started.codebaseId).toBe('cb-1');

    const poll = events.find(e => e.type === 'tracker_poll_completed');
    expect(poll && poll.type === 'tracker_poll_completed' && poll.tracker).toBe('linear');
    expect(poll && poll.type === 'tracker_poll_completed' && poll.candidateCount).toBe(1);

    await orch.stop();
  });

  test('workflow_failed emits dispatch_failed and dispatch_retry_scheduled', async () => {
    const issue = makeIssue({ id: 'l-2', identifier: 'APP-2', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    const { events, getEmitter } = makeRecorder();
    let scheduled: ReturnType<typeof setTimeout> | null = null;
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => workflowEmitter,
      getSymphonyEmitter: getEmitter,
      scheduleTimeout: (_fn, ms) => {
        if (ms > 0) scheduled = setTimeout(() => undefined, 100000);
        return scheduled ?? (0 as unknown as ReturnType<typeof setTimeout>);
      },
      cancelTimeout: handle => {
        if (handle) clearTimeout(handle);
      },
    });
    orch.start();
    await orch.runTick();

    const dk = buildDispatchKey('linear', 'APP-2');
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');
    const runId = entry.workflow_run_id;

    workflowEmitter.emit({
      type: 'workflow_failed',
      runId,
      workflowName: 'archon-feature-development',
      error: 'turn timeout',
    });
    await new Promise(r => setTimeout(r, 10));

    const failed = events.find(e => e.type === 'dispatch_failed');
    expect(failed).toBeDefined();
    expect(failed && failed.type === 'dispatch_failed' && failed.workflowRunId).toBe(runId);
    expect(failed && failed.type === 'dispatch_failed' && failed.errorMessage).toBe('turn timeout');

    const retry = events.find(e => e.type === 'dispatch_retry_scheduled');
    expect(retry).toBeDefined();
    expect(retry && retry.type === 'dispatch_retry_scheduled' && retry.delayKind).toBe('failure');

    await orch.stop();
  });

  test('workflow_cancelled emits dispatch_cancelled', async () => {
    const issue = makeIssue({ id: 'l-3', identifier: 'APP-3', state: 'Todo' });
    const { tracker } = makeFakeTracker([issue]);
    const { events, getEmitter } = makeRecorder();
    const orch = new Orchestrator({
      getSnapshot: () => snap(),
      trackers: { linear: tracker },
      getDb: () => db,
      bridge: fakeBridge.bridge,
      getEventEmitter: () => workflowEmitter,
      getSymphonyEmitter: getEmitter,
      scheduleTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
      cancelTimeout: () => undefined,
    });
    orch.start();
    await orch.runTick();

    const dk = buildDispatchKey('linear', 'APP-3');
    const entry = orch.getRunning(dk);
    if (!entry?.workflow_run_id) throw new Error('expected running entry');
    const runId = entry.workflow_run_id;

    workflowEmitter.emit({
      type: 'workflow_cancelled',
      runId,
      nodeId: 'n0',
      reason: 'user_requested',
    });
    await new Promise(r => setTimeout(r, 10));

    const cancelled = events.find(e => e.type === 'dispatch_cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled && cancelled.type === 'dispatch_cancelled' && cancelled.reason).toBe(
      'user_requested'
    );
    expect(cancelled && cancelled.type === 'dispatch_cancelled' && cancelled.workflowRunId).toBe(
      runId
    );

    await orch.stop();
  });
});
