import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

  it('writes one canonical record to durable, transcript, emitter and runtime sinks', async () => {
    const durable: NodeStateEventInput[] = [];
    const emitted: WorkflowEmitterEvent[] = [];
    const store = {
      persistWorkflowEvent: mock(async (event: NodeStateEventInput) => durable.push(event)),
    } as never;
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

  it('stops after a durable write rejection and preserves the original failure', async () => {
    const cause = new Error('database unavailable');
    const store = { persistWorkflowEvent: mock(async () => Promise.reject(cause)) } as never;
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
    expect(emitter.emit).not.toHaveBeenCalled();
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
