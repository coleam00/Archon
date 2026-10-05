import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEmitterEvent } from './event-emitter';
import {
  deriveEmitterEvent,
  deriveTranscriptEvent,
  NodeEventWriteError,
  recordDerivedNodeState,
  recordNodeState,
} from './node-event-write';
import type { NodeExecutionRecord } from './schemas/node-execution';
import type { NodeStateEventInput } from './store';

const completedRecord = (): NodeExecutionRecord => ({
  runId: 'run-1',
  path: 'group.build',
  node: { id: 'build', kind: 'exec', runtime: 'sh' },
  invocation: { id: 'inv-1', startedAt: '2026-09-22T10:00:00Z', loopPath: [] },
  attempt: { id: 'attempt-1', startedAt: '2026-09-22T10:00:00Z' },
  binding: {},
  timing: { startedAt: '2026-09-22T10:00:00Z', durationMs: 12 },
  spend: {
    tokens: { source: 'provider', value: { input: 0, output: 0 } },
    costUsd: { source: 'provider', value: 0 },
    stopReason: { source: 'unavailable', reason: 'not_applicable' },
    numTurns: { source: 'unavailable', reason: 'not_applicable' },
  },
  accounting: 'node',
  lifecycle: { status: 'completed' },
  output: { text: 'full output', persisted: { text: 'preview', truncated: true } },
});

describe('node-event-write', () => {
  let logDir: string;
  beforeEach(async () => {
    logDir = join(tmpdir(), `node-event-write-${crypto.randomUUID()}`);
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(logDir);
  });

  it('writes one canonical record to durable, transcript, emitter and runtime sinks', async () => {
    const durable: NodeStateEventInput[] = [];
    const emitted: WorkflowEmitterEvent[] = [];
    const store = {
      persistWorkflowEvent: mock(async (event: NodeStateEventInput) => {
        durable.push(event);
      }),
    };
    const emitter = { emit: mock((event: WorkflowEmitterEvent) => emitted.push(event)) };
    const result = await recordNodeState({ store, logDir, emitter }, completedRecord());

    expect(durable[0]).toMatchObject({
      workflow_run_id: 'run-1',
      step_name: 'group.build',
      event_type: 'node_completed',
      data: { node_output: 'preview', node_output_truncated: true, cost_usd: 0 },
    });
    const transcript = JSON.parse(await readFile(join(logDir, 'run-1.jsonl'), 'utf8'));
    expect(transcript).toMatchObject({ type: 'node_complete', step: 'build', duration_ms: 12 });
    expect(emitted[0]).toMatchObject({ type: 'node_completed', duration: 12, costUsd: 0 });
    expect(result).toMatchObject({ state: 'completed', output: 'full output', costUsd: 0 });
  });

  it.each([{ code: 'SQLITE_BUSY' }, { errno: 5 }])(
    'waits for structured busy errors %j before publishing completion',
    async busy => {
      const durable: NodeStateEventInput[] = [];
      const emitter = { emit: mock(() => {}) };
      let attempts = 0;
      const store = {
        persistWorkflowEvent: mock(async (event: NodeStateEventInput) => {
          expect(emitter.emit).not.toHaveBeenCalled();
          expect(await Bun.file(join(logDir, 'run-1.jsonl')).exists()).toBe(false);
          if (++attempts <= 3) throw Object.assign(new Error('contention'), busy);
          durable.push(event);
        }),
      };

      const result = await recordNodeState({ store, logDir, emitter }, completedRecord());

      expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(4);
      expect(durable).toHaveLength(1);
      expect(durable[0]?.event_type).toBe('node_completed');
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const lines = (await readFile(join(logDir, 'run-1.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(result).toMatchObject({ state: 'completed', output: 'full output' });
    }
  );

  it('returns and persists the same nested contract on cache replay', async () => {
    const durable: NodeStateEventInput[] = [];
    const store = {
      persistWorkflowEvent: async (event: NodeStateEventInput) => {
        durable.push(event);
      },
    };
    const source = completedRecord();
    const paths = [['proposal'], ['proposal', 'action']];
    const result = await recordNodeState(
      { store, logDir },
      {
        runId: source.runId,
        path: source.path,
        node: source.node,
        cache: {
          action: 'replayed',
          output: { text: 'json', declaredOutputPaths: paths },
        },
      }
    );
    expect(result).toMatchObject({ state: 'completed', declaredOutputPaths: paths });
    expect(durable[0]?.data?.declared_output_paths).toEqual(paths);
  });

  it.each([
    new Error('SQLITE_BUSY: database is locked'),
    Object.assign(new Error('database is locked'), { code: 'SQLITE_LOCKED', errno: 6 }),
    Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT', errno: 19 }),
  ])('stops after a non-busy rejection and preserves the original failure: %j', async cause => {
    const store = { persistWorkflowEvent: mock(async () => Promise.reject(cause)) };
    const emitter = { emit: mock(() => {}) };
    const record = {
      ...completedRecord(),
      lifecycle: { status: 'failed' as const, error: 'child failed' },
    };
    await expect(recordNodeState({ store, logDir, emitter }, record)).rejects.toMatchObject({
      name: NodeEventWriteError.name,
      cause,
      message: expect.stringContaining('child failed'),
    });
    expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(await Bun.file(join(logDir, 'run-1.jsonl')).exists()).toBe(false);
  });

  it('preserves a non-busy failure after waiting on a busy write', async () => {
    const cause = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL', errno: 13 });
    let attempts = 0;
    const store = {
      persistWorkflowEvent: mock(async () => {
        if (++attempts === 1) throw { errno: 5 };
        throw cause;
      }),
    };
    const emitter = { emit: mock(() => {}) };
    await expect(
      recordNodeState({ store, logDir, emitter }, completedRecord())
    ).rejects.toMatchObject({
      name: NodeEventWriteError.name,
      cause,
    });
    expect(attempts).toBe(2);
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(await Bun.file(join(logDir, 'run-1.jsonl')).exists()).toBe(false);
  });

  it('names a packaged command node by its bare command name on the derived emitter path', () => {
    const packaged = '__archon_pack__installed:Wirasm.archon-video:make::pick';
    const node = {
      id: 'pick-node',
      kind: 'agent' as const,
      source: { kind: 'command' as const, name: packaged },
    };
    const event: NodeStateEventInput = {
      workflow_run_id: 'run-1',
      step_name: 'pick-node',
      event_type: 'node_completed',
      data: { node_output: 'approved' },
    };
    expect(deriveEmitterEvent(node, event)).toMatchObject({
      nodeId: 'pick-node',
      nodeName: 'pick',
    });
    expect(deriveTranscriptEvent(node, event)).toMatchObject({ content: packaged });
  });

  it('derives an old transactional wait completion without inventing metadata or duration', async () => {
    const waitNode = { id: 'wait-for-ci', kind: 'wait' as const, wait: { duration_ms: 1 } };
    const event: NodeStateEventInput = {
      workflow_run_id: 'old-run',
      step_name: 'wait-for-ci',
      event_type: 'node_completed',
      data: { node_output: '{"status":"satisfied"}', type: 'wait' },
    };
    expect(deriveTranscriptEvent(waitNode, event)).toEqual({
      type: 'node_complete',
      step: 'wait-for-ci',
      content: '<wait>',
    });
    expect(deriveEmitterEvent(waitNode, event)).toEqual({
      type: 'node_completed',
      runId: 'old-run',
      nodeId: 'wait-for-ci',
      nodeName: 'wait-for-ci',
    });

    const emitted: WorkflowEmitterEvent[] = [];
    await recordDerivedNodeState(
      { logDir, emitter: { emit: event => emitted.push(event) } },
      waitNode,
      event
    );
    expect(emitted[0]).not.toHaveProperty('execution');
    expect(emitted[0]).not.toHaveProperty('duration');
  });
});
