import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) ---
// event-emitter.ts uses a lazy-initialized logger via getLog(), so we must
// mock @archon/paths before any import of event-emitter.

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

// --- Imports (after mocks) ---

import {
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from './event-emitter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflowStartedEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'workflow_started',
    runId,
    workflowName: 'test-workflow',
    conversationId: 'conv-1',
  };
}

function makeWorkflowCompletedEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'workflow_completed',
    runId,
    workflowName: 'test-workflow',
    duration: 1234,
  };
}

function makeWorkflowFailedEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'workflow_failed',
    runId,
    workflowName: 'test-workflow',
    error: 'Something went wrong',
  };
}

function makeNodeStartedEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'node_started',
    runId,
    nodeId: 'classify',
    nodeName: 'classify-issue',
  };
}

function makeNodeSkippedEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'node_skipped',
    runId,
    nodeId: 'skip-me',
    nodeName: 'optional-node',
    reason: 'when_condition',
  };
}

function makeArtifactEvent(runId = 'run-1'): WorkflowEmitterEvent {
  return {
    type: 'workflow_artifact',
    runId,
    artifactType: 'log',
    label: 'Execution log',
    path: '/tmp/workflow.log',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowEventEmitter', () => {
  // Reset singleton between every test so each test gets a clean emitter.
  beforeEach(() => {
    resetWorkflowEventEmitter();
    // Clear mock call counts
    mockLogFn.mockClear();
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  describe('getWorkflowEventEmitter() singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = getWorkflowEventEmitter();
      const b = getWorkflowEventEmitter();
      expect(a).toBe(b);
    });

    it('returns a new instance after resetWorkflowEventEmitter()', () => {
      const a = getWorkflowEventEmitter();
      resetWorkflowEventEmitter();
      const b = getWorkflowEventEmitter();
      expect(a).not.toBe(b);
    });

    it('new instance after reset has no prior subscribers', () => {
      const emitter = getWorkflowEventEmitter();
      const listener = mock((_event: WorkflowEmitterEvent) => {});
      emitter.subscribe(listener);

      resetWorkflowEventEmitter();
      const freshEmitter = getWorkflowEventEmitter();
      freshEmitter.emit(makeWorkflowStartedEvent());

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // subscribe / unsubscribe
  // -------------------------------------------------------------------------

  describe('subscribe()', () => {
    it('adds a listener that receives emitted events', () => {
      const emitter = getWorkflowEventEmitter();
      const listener = mock((_event: WorkflowEmitterEvent) => {});

      emitter.subscribe(listener);
      emitter.emit(makeWorkflowStartedEvent());

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toMatchObject({
        type: 'workflow_started',
        runId: 'run-1',
      });
    });

    it('returns an unsubscribe function', () => {
      const emitter = getWorkflowEventEmitter();
      const unsubscribe = emitter.subscribe(mock(() => {}));
      expect(typeof unsubscribe).toBe('function');
    });

    it('calling the returned unsubscribe function stops event delivery', () => {
      const emitter = getWorkflowEventEmitter();
      const listener = mock((_event: WorkflowEmitterEvent) => {});

      const unsubscribe = emitter.subscribe(listener);
      emitter.emit(makeWorkflowStartedEvent());
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit(makeWorkflowCompletedEvent());
      // Still only 1 call — the second event was not delivered
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('unsubscribing one listener does not affect other listeners', () => {
      const emitter = getWorkflowEventEmitter();
      const listenerA = mock((_event: WorkflowEmitterEvent) => {});
      const listenerB = mock((_event: WorkflowEmitterEvent) => {});

      const unsubscribeA = emitter.subscribe(listenerA);
      emitter.subscribe(listenerB);

      emitter.emit(makeNodeStartedEvent());
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);

      unsubscribeA();
      emitter.emit(makeWorkflowCompletedEvent());

      // A was removed, B still receives events
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(2);
    });

    it('calling unsubscribe multiple times is idempotent', () => {
      const emitter = getWorkflowEventEmitter();
      const listener = mock((_event: WorkflowEmitterEvent) => {});

      const unsubscribe = emitter.subscribe(listener);
      unsubscribe();
      // Second call should not throw
      expect(() => unsubscribe()).not.toThrow();

      emitter.emit(makeWorkflowStartedEvent());
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // emit()
  // -------------------------------------------------------------------------

  describe('emit()', () => {
    it('delivers event to all current subscribers', () => {
      const emitter = getWorkflowEventEmitter();
      const listeners = Array.from({ length: 5 }, () => mock((_event: WorkflowEmitterEvent) => {}));
      listeners.forEach(l => emitter.subscribe(l));

      const event = makeNodeStartedEvent();
      emitter.emit(event);

      for (const l of listeners) {
        expect(l).toHaveBeenCalledTimes(1);
        expect(l.mock.calls[0][0]).toBe(event);
      }
    });

    it('does not throw when there are no subscribers', () => {
      const emitter = getWorkflowEventEmitter();
      expect(() => emitter.emit(makeWorkflowStartedEvent())).not.toThrow();
    });

    it('delivers multiple sequential events in order', () => {
      const emitter = getWorkflowEventEmitter();
      const received: string[] = [];
      emitter.subscribe(event => received.push(event.type));

      emitter.emit(makeWorkflowStartedEvent());
      emitter.emit(makeNodeStartedEvent());
      emitter.emit(makeNodeSkippedEvent());
      emitter.emit(makeWorkflowCompletedEvent());

      expect(received).toEqual([
        'workflow_started',
        'node_started',
        'node_skipped',
        'workflow_completed',
      ]);
    });

    it('passes the exact event object to each subscriber', () => {
      const emitter = getWorkflowEventEmitter();
      const captured: WorkflowEmitterEvent[] = [];
      emitter.subscribe(event => captured.push(event));

      const artifact = makeArtifactEvent();
      emitter.emit(artifact);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toBe(artifact);
    });

    it('delivers all WorkflowEmitterEvent variants without error', () => {
      const emitter = getWorkflowEventEmitter();
      const received: string[] = [];
      emitter.subscribe(e => received.push(e.type));

      const events: WorkflowEmitterEvent[] = [
        makeWorkflowStartedEvent(),
        makeWorkflowCompletedEvent(),
        makeWorkflowFailedEvent(),
        { type: 'loop_iteration_started', runId: 'run-1', iteration: 1, maxIterations: 5 },
        {
          type: 'loop_iteration_completed',
          runId: 'run-1',
          iteration: 1,
          duration: 600,
          completionDetected: false,
        },
        { type: 'loop_iteration_failed', runId: 'run-1', iteration: 1, error: 'loop error' },
        makeNodeStartedEvent(),
        {
          type: 'node_completed',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify-issue',
          duration: 150,
        },
        {
          type: 'node_failed',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify-issue',
          error: 'fail',
        },
        makeNodeSkippedEvent(),
        makeArtifactEvent(),
      ];

      for (const event of events) {
        expect(() => emitter.emit(event)).not.toThrow();
      }

      expect(received).toHaveLength(events.length);
    });
  });

  // -------------------------------------------------------------------------
  // Listener error isolation
  // -------------------------------------------------------------------------

  describe('listener error isolation', () => {
    it('a throwing listener does not prevent other listeners from receiving the event', () => {
      const emitter = getWorkflowEventEmitter();
      const goodListenerBefore = mock((_event: WorkflowEmitterEvent) => {});
      const throwingListener = mock((_event: WorkflowEmitterEvent) => {
        throw new Error('Listener explosion');
      });
      const goodListenerAfter = mock((_event: WorkflowEmitterEvent) => {});

      emitter.subscribe(goodListenerBefore);
      emitter.subscribe(throwingListener);
      emitter.subscribe(goodListenerAfter);

      // emit() itself must not throw even when a subscriber throws
      expect(() => emitter.emit(makeWorkflowStartedEvent())).not.toThrow();

      expect(goodListenerBefore).toHaveBeenCalledTimes(1);
      expect(throwingListener).toHaveBeenCalledTimes(1);
      expect(goodListenerAfter).toHaveBeenCalledTimes(1);
    });

    it('logs listener errors via the internal logger', () => {
      const emitter = getWorkflowEventEmitter();
      const error = new Error('listener boom');
      emitter.subscribe(() => {
        throw error;
      });

      mockLogFn.mockClear();
      emitter.emit(makeWorkflowStartedEvent());

      // The error should have been logged (mockLogger.error is mockLogFn)
      expect(mockLogFn).toHaveBeenCalledTimes(1);
    });

    it('multiple throwing listeners each log their own error without affecting neighbours', () => {
      const emitter = getWorkflowEventEmitter();
      const good = mock((_event: WorkflowEmitterEvent) => {});

      emitter.subscribe(() => {
        throw new Error('first');
      });
      emitter.subscribe(good);
      emitter.subscribe(() => {
        throw new Error('second');
      });

      mockLogFn.mockClear();
      expect(() => emitter.emit(makeNodeStartedEvent())).not.toThrow();

      expect(good).toHaveBeenCalledTimes(1);
      // Two throws → two error log calls
      expect(mockLogFn).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // registerRun / unregisterRun
  // -------------------------------------------------------------------------

  describe('registerRun() / unregisterRun()', () => {
    it('registerRun() maps a runId to a conversationId', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-42', 'conv-abc');
      expect(emitter.getConversationId('run-42')).toBe('conv-abc');
    });

    it('unregisterRun() removes the mapping', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-42', 'conv-abc');
      emitter.unregisterRun('run-42');
      expect(emitter.getConversationId('run-42')).toBeUndefined();
    });

    it('unregisterRun() for an unknown runId does not throw', () => {
      const emitter = getWorkflowEventEmitter();
      expect(() => emitter.unregisterRun('non-existent-run')).not.toThrow();
    });

    it('multiple runs can be registered simultaneously', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-1', 'conv-1');
      emitter.registerRun('run-2', 'conv-2');
      emitter.registerRun('run-3', 'conv-3');

      expect(emitter.getConversationId('run-1')).toBe('conv-1');
      expect(emitter.getConversationId('run-2')).toBe('conv-2');
      expect(emitter.getConversationId('run-3')).toBe('conv-3');
    });

    it('re-registering a runId with a different conversationId overwrites the mapping', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-1', 'conv-old');
      emitter.registerRun('run-1', 'conv-new');
      expect(emitter.getConversationId('run-1')).toBe('conv-new');
    });

    it('unregistering one run does not affect other runs', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-A', 'conv-A');
      emitter.registerRun('run-B', 'conv-B');

      emitter.unregisterRun('run-A');

      expect(emitter.getConversationId('run-A')).toBeUndefined();
      expect(emitter.getConversationId('run-B')).toBe('conv-B');
    });
  });

  // -------------------------------------------------------------------------
  // getConversationId()
  // -------------------------------------------------------------------------

  describe('getConversationId()', () => {
    it('returns undefined for an unregistered runId', () => {
      const emitter = getWorkflowEventEmitter();
      expect(emitter.getConversationId('unknown-run')).toBeUndefined();
    });

    it('returns the correct conversationId for a registered runId', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('my-run', 'my-conv');
      expect(emitter.getConversationId('my-run')).toBe('my-conv');
    });

    it('returns undefined after unregistering', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('my-run', 'my-conv');
      emitter.unregisterRun('my-run');
      expect(emitter.getConversationId('my-run')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // subscribeForConversation()
  // -------------------------------------------------------------------------

  describe('subscribeForConversation()', () => {
    it('delivers events only for the specified conversation', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-A', 'conv-A');
      emitter.registerRun('run-B', 'conv-B');

      const listenerA = mock((_event: WorkflowEmitterEvent) => {});
      const listenerB = mock((_event: WorkflowEmitterEvent) => {});

      emitter.subscribeForConversation('conv-A', listenerA);
      emitter.subscribeForConversation('conv-B', listenerB);

      emitter.emit(makeWorkflowStartedEvent('run-A'));
      emitter.emit(makeWorkflowStartedEvent('run-B'));

      // listenerA receives only run-A's event
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerA.mock.calls[0][0]).toMatchObject({ runId: 'run-A' });

      // listenerB receives only run-B's event
      expect(listenerB).toHaveBeenCalledTimes(1);
      expect(listenerB.mock.calls[0][0]).toMatchObject({ runId: 'run-B' });
    });

    it('does not deliver events for runs that are not registered to any conversation', () => {
      const emitter = getWorkflowEventEmitter();
      // run-X is not registered
      const listener = mock((_event: WorkflowEmitterEvent) => {});
      emitter.subscribeForConversation('conv-A', listener);

      emitter.emit(makeWorkflowStartedEvent('run-X'));

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns a working unsubscribe function', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-1', 'conv-1');

      const listener = mock((_event: WorkflowEmitterEvent) => {});
      const unsubscribe = emitter.subscribeForConversation('conv-1', listener);

      emitter.emit(makeNodeStartedEvent('run-1'));
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      emitter.emit(makeWorkflowCompletedEvent('run-1'));
      // Unsubscribed — no more calls
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('one conversation subscriber does not interfere with global subscribers', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-1', 'conv-1');

      const globalListener = mock((_event: WorkflowEmitterEvent) => {});
      const convListener = mock((_event: WorkflowEmitterEvent) => {});

      emitter.subscribe(globalListener);
      emitter.subscribeForConversation('conv-1', convListener);

      emitter.emit(makeWorkflowStartedEvent('run-1'));

      expect(globalListener).toHaveBeenCalledTimes(1);
      expect(convListener).toHaveBeenCalledTimes(1);
    });

    it('delivers multiple events for the same conversation', () => {
      const emitter = getWorkflowEventEmitter();
      emitter.registerRun('run-1', 'conv-1');

      const received: string[] = [];
      emitter.subscribeForConversation('conv-1', e => received.push(e.type));

      emitter.emit(makeWorkflowStartedEvent('run-1'));
      emitter.emit(makeNodeStartedEvent('run-1'));
      emitter.emit(makeNodeSkippedEvent('run-1'));
      emitter.emit(makeWorkflowCompletedEvent('run-1'));

      expect(received).toEqual([
        'workflow_started',
        'node_started',
        'node_skipped',
        'workflow_completed',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: full workflow lifecycle
  // -------------------------------------------------------------------------

  describe('integration: full workflow lifecycle', () => {
    it('simulates a complete workflow run with all events forwarded to subscribers', () => {
      const emitter = getWorkflowEventEmitter();

      const runId = 'integration-run';
      const conversationId = 'integration-conv';
      emitter.registerRun(runId, conversationId);

      const allEvents: WorkflowEmitterEvent[] = [];
      const convEvents: WorkflowEmitterEvent[] = [];

      emitter.subscribe(e => allEvents.push(e));
      emitter.subscribeForConversation(conversationId, e => convEvents.push(e));

      // Emit a realistic DAG workflow sequence
      emitter.emit({
        type: 'workflow_started',
        runId,
        workflowName: 'plan-implement',
        conversationId,
      });
      emitter.emit({ type: 'node_started', runId, nodeId: 'plan', nodeName: 'plan' });
      emitter.emit({
        type: 'node_completed',
        runId,
        nodeId: 'plan',
        nodeName: 'plan',
        duration: 400,
      });
      emitter.emit({ type: 'node_started', runId, nodeId: 'implement', nodeName: 'implement' });
      emitter.emit({
        type: 'workflow_artifact',
        runId,
        artifactType: 'log',
        label: 'build output',
        path: '/tmp/out.log',
      });
      emitter.emit({
        type: 'node_completed',
        runId,
        nodeId: 'implement',
        nodeName: 'implement',
        duration: 900,
      });
      emitter.emit({
        type: 'workflow_completed',
        runId,
        workflowName: 'plan-implement',
        duration: 1300,
      });

      expect(allEvents).toHaveLength(7);
      expect(convEvents).toHaveLength(7);
      expect(allEvents.map(e => e.type)).toEqual(convEvents.map(e => e.type));

      // Clean up
      emitter.unregisterRun(runId);
      expect(emitter.getConversationId(runId)).toBeUndefined();
    });

    it('events from a different run are not delivered to conversation-scoped subscriber', () => {
      const emitter = getWorkflowEventEmitter();

      emitter.registerRun('run-target', 'conv-target');
      emitter.registerRun('run-other', 'conv-other');

      const targetEvents: WorkflowEmitterEvent[] = [];
      emitter.subscribeForConversation('conv-target', e => targetEvents.push(e));

      emitter.emit(makeWorkflowStartedEvent('run-other'));
      emitter.emit(makeNodeStartedEvent('run-other'));
      emitter.emit(makeWorkflowStartedEvent('run-target'));

      // Only the run-target event should arrive
      expect(targetEvents).toHaveLength(1);
      expect(targetEvents[0]).toMatchObject({ runId: 'run-target' });
    });
  });
});
