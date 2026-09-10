import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordNodeState,
  deriveTranscriptEvent,
  deriveEmitterEvent,
  NodeEventWriteError,
} from './node-event-write';
import type { NodeStateEventInput } from './store';
import type { ExecNode, SkipCause } from './schemas';
import type { WorkflowEmitterEvent } from './event-emitter';
import { getWorkflowEventEmitter } from './event-emitter';

/** A minimal authored node; node-state facts are always about a real node. */
const step = (id: string): ExecNode => ({ id, kind: 'exec', runtime: 'sh', script: ':' });

describe('node-event-write', () => {
  let testLogDir: string;

  beforeEach(async () => {
    testLogDir = join(
      tmpdir(),
      `node-event-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testLogDir, { recursive: true });
  });

  const readTranscriptRows = async (runId: string): Promise<Record<string, unknown>[]> => {
    try {
      const content = await readFile(join(testLogDir, `${runId}.jsonl`), 'utf8');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };

  describe('sink mutation tests (proving no sink can be silently dropped)', () => {
    it('writes to all three sinks for node_completed', async () => {
      const persistedEvents: NodeStateEventInput[] = [];
      const emittedEvents: WorkflowEmitterEvent[] = [];
      const store = {
        persistWorkflowEvent: mock(async (event: NodeStateEventInput) => {
          persistedEvents.push(event);
        }),
      } as any;
      const emitter = {
        emit: mock((event: WorkflowEmitterEvent) => {
          emittedEvents.push(event);
        }),
      };

      const event: NodeStateEventInput = {
        workflow_run_id: 'run-1',
        event_type: 'node_completed',
        step_name: 'test-node',
        data: {
          duration_ms: 150,
          cost_usd: 0.05,
          tokens: { input_tokens: 100, output_tokens: 50 },
        },
      };

      await recordNodeState({ store, logDir: testLogDir, emitter }, step('test-node'), event);

      // Sink 1: DB sink
      expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
      expect(persistedEvents).toHaveLength(1);
      expect(persistedEvents[0].event_type).toBe('node_completed');

      // Sink 2: Transcript sink
      const transcriptRows = await readTranscriptRows('run-1');
      expect(transcriptRows).toHaveLength(1);
      expect(transcriptRows[0]).toMatchObject({
        type: 'node_complete',
        step: 'test-node',
        duration_ms: 150,
        cost_usd: 0.05,
      });

      // Sink 3: Emitter sink
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toMatchObject({
        type: 'node_completed',
        nodeId: 'test-node',
        duration: 150,
        costUsd: 0.05,
      });
    });

    it('fails if DB sink is dropped (mutation proof)', async () => {
      const store = {
        persistWorkflowEvent: mock(async () => {}),
      } as any;
      const emitter = { emit: mock(() => {}) };

      await recordNodeState({ store, logDir: testLogDir, emitter }, step('node-1'), {
        workflow_run_id: 'run-db',
        event_type: 'node_started',
        step_name: 'node-1',
      });

      // If DB sink was dropped, this expectation fails
      expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
    });

    it('fails if transcript sink is dropped (mutation proof)', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitter = { emit: mock(() => {}) };

      await recordNodeState({ store, logDir: testLogDir, emitter }, step('node-tr'), {
        workflow_run_id: 'run-tr',
        event_type: 'node_completed',
        step_name: 'node-tr',
        data: { duration_ms: 10 },
      });

      const rows = await readTranscriptRows('run-tr');
      // If transcript write was dropped, rows would be empty and this expectation fails
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('node_complete');
    });

    it('fails if emitter sink is dropped (mutation proof)', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitter = { emit: mock(() => {}) };

      await recordNodeState({ store, logDir: testLogDir, emitter }, step('node-em'), {
        workflow_run_id: 'run-em',
        event_type: 'node_failed',
        step_name: 'node-em',
        data: { error: 'boom' },
      });

      // If emitter sink was dropped, this expectation fails
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'node_failed' }));
    });
  });

  describe('write error propagation (preserving PR #3254 policy)', () => {
    it('surfaces storage rejection as NodeEventWriteError with original node failure in message', async () => {
      const originalError = 'TypeError: cannot read properties of undefined';
      const storageCause = new Error('database connection refused');
      const store = {
        persistWorkflowEvent: mock(async () => {
          throw storageCause;
        }),
      } as any;
      const emitter = { emit: mock(() => {}) };

      const event: NodeStateEventInput = {
        workflow_run_id: 'run-err',
        event_type: 'node_failed',
        step_name: 'failing-node',
        data: { error: originalError },
      };

      const recordPromise = recordNodeState(
        { store, logDir: testLogDir, emitter },
        step('failing-node'),
        event
      );

      await expect(recordPromise).rejects.toBeInstanceOf(NodeEventWriteError);
      await expect(recordPromise).rejects.toMatchObject({
        cause: storageCause,
        message: expect.stringContaining(originalError),
      });

      // Neither transcript nor emitter should be called when storage rejects
      const rows = await readTranscriptRows('run-err');
      expect(rows).toHaveLength(0);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('transcript failure does not fail the node (best-effort transcript)', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitter = { emit: mock(() => {}) };

      // Invalid logDir that cannot be written to
      const invalidLogDir = '/dev/null/impossible-path';

      await expect(
        recordNodeState({ store, logDir: invalidLogDir, emitter }, step('node-tr-fail'), {
          workflow_run_id: 'run-fail',
          event_type: 'node_completed',
          step_name: 'node-tr-fail',
        })
      ).resolves.toBeUndefined();

      // DB and emitter still succeeded
      expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledTimes(1);
    });

    it('a crashing emitter listener does not propagate to the caller', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitter = getWorkflowEventEmitter();
      const unsubscribe = emitter.subscribe(() => {
        throw new Error('listener crashed');
      });
      try {
        await expect(
          recordNodeState({ store, logDir: testLogDir, emitter }, step('node-emit-fail'), {
            workflow_run_id: 'run-emit',
            event_type: 'node_completed',
            step_name: 'node-emit-fail',
          })
        ).resolves.toBeUndefined();
      } finally {
        unsubscribe();
      }

      expect(store.persistWorkflowEvent).toHaveBeenCalledTimes(1);
    });

    it('a derivation defect surfaces instead of degrading to a warning', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitter = { emit: mock(() => {}) };

      await expect(
        recordNodeState({ store, logDir: testLogDir, emitter }, step('node-bogus'), {
          workflow_run_id: 'run-bogus',
          event_type: 'not_a_node_state' as never,
          step_name: 'node-bogus',
        })
      ).rejects.toThrow(/Unhandled NodeStateEventType/);

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('trigger_rule skip retaining cause axis', () => {
    it('records cause in transcript and emitter for trigger_rule skip', async () => {
      const store = { persistWorkflowEvent: mock(async () => {}) } as any;
      const emitted: WorkflowEmitterEvent[] = [];
      const emitter = {
        emit: mock((e: WorkflowEmitterEvent) => emitted.push(e)),
      };

      const cause: SkipCause = { kind: 'upstream_failed', origin: 'step-a' };
      const event: NodeStateEventInput = {
        workflow_run_id: 'run-skip',
        event_type: 'node_skipped',
        step_name: 'step-b',
        data: { reason: 'trigger_rule', cause },
      };

      await recordNodeState({ store, logDir: testLogDir, emitter }, step('step-b'), event);

      // Verify transcript has cause
      const rows = await readTranscriptRows('run-skip');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'node_skipped',
        step: 'step-b',
        content: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin: 'step-a' },
      });

      // Verify emitter has cause
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: 'node_skipped',
        nodeId: 'step-b',
        reason: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin: 'step-a' },
      });
    });
  });

  describe('derivation mappings over NodeStateEventType', () => {
    it('node_skipped_prior_success folds to node_skipped emitter event', () => {
      const event: NodeStateEventInput = {
        workflow_run_id: 'run-prior',
        event_type: 'node_skipped_prior_success',
        step_name: 'cached-step',
        data: { reason: 'prior_success' },
      };

      const transcript = deriveTranscriptEvent(step('cached-step'), event);
      expect(transcript).toEqual({
        type: 'node_skipped',
        step: 'cached-step',
        content: 'prior_success',
      });

      const emitter = deriveEmitterEvent(step('cached-step'), event);
      expect(emitter).toEqual({
        type: 'node_skipped',
        runId: 'run-prior',
        nodeId: 'cached-step',
        nodeName: 'cached-step',
        reason: 'prior_success',
      });
    });

    it('node_prior_cache_invalidated and node_always_run_reset have no transcript row and no emitter event', () => {
      const invalidated: NodeStateEventInput = {
        workflow_run_id: 'run-inv',
        event_type: 'node_prior_cache_invalidated',
        step_name: 'step-inv',
        data: { reason: 'stale_dependency' },
      };
      expect(deriveTranscriptEvent(step('step-inv'), invalidated)).toBeUndefined();
      expect(deriveEmitterEvent(step('step-inv'), invalidated)).toBeUndefined();

      const alwaysRun: NodeStateEventInput = {
        workflow_run_id: 'run-ar',
        event_type: 'node_always_run_reset',
        step_name: 'step-ar',
      };
      expect(deriveTranscriptEvent(step('step-ar'), alwaysRun)).toBeUndefined();
      expect(deriveEmitterEvent(step('step-ar'), alwaysRun)).toBeUndefined();
    });

    it('node_started derives provider, model, tier, and effort', () => {
      const event: NodeStateEventInput = {
        workflow_run_id: 'run-start',
        event_type: 'node_started',
        step_name: 'step-start',
        data: { command: 'implement.md' },
      };

      const node = step('step-start');
      const execution = {
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        tier: 'medium' as const,
        effort: 'high' as const,
      };

      const transcript = deriveTranscriptEvent(node, event);
      expect(transcript).toMatchObject({
        type: 'node_start',
        step: 'step-start',
        content: 'implement.md',
      });

      const emitter = deriveEmitterEvent(node, event, execution);
      expect(emitter).toMatchObject({
        type: 'node_started',
        nodeId: 'step-start',
        provider: 'claude',
        model: 'claude-3-7-sonnet',
        tier: 'medium',
        effort: 'high',
      });
    });
  });

  describe('spend on a failure row (#2693)', () => {
    const failed = (data: Record<string, unknown>): NodeStateEventInput => ({
      workflow_run_id: 'run-spend',
      event_type: 'node_failed',
      step_name: 'step-f',
      data: { error: 'boom', ...data },
    });

    it('keeps a reported zero cost distinct from an unreported one', () => {
      const zero = deriveTranscriptEvent(step('step-f'), failed({ cost_usd: 0 }));
      const absent = deriveTranscriptEvent(
        step('step-f'),
        failed({ tokens: { input: 5, output: 1 } })
      );
      expect(zero).toMatchObject({ type: 'node_error', cost_usd: 0 });
      expect(absent !== undefined && 'cost_usd' in absent).toBe(false);
      expect(absent).toMatchObject({ tokens: { input: 5, output: 1 } });
    });

    it('writes no usage keys for a failure that could not have spent anything', () => {
      const bare = deriveTranscriptEvent(step('step-f'), failed({}));
      expect(bare).toMatchObject({ type: 'node_error', error: 'boom' });
      expect(bare !== undefined && 'cost_usd' in bare).toBe(false);
      expect(bare !== undefined && 'tokens' in bare).toBe(false);
    });
  });

  describe('dag-executor source conformance', () => {
    it('proves no persistNodeEvent call remains in dag-executor.ts (all routed through recordNodeState)', async () => {
      const source = await readFile(join(__dirname, 'dag-executor.ts'), 'utf8');
      const lines = source.split('\n');
      const directCalls = lines
        .map((line, idx) => ({ line: idx + 1, text: line.trim() }))
        .filter(({ text }) => text.includes('persistNodeEvent('));

      expect(directCalls).toEqual([]);
    });
  });
});
