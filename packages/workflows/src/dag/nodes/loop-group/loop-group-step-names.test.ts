// @archon-test-isolated
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockClaudeCapabilities,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  createMockDeps,
  createMockPlatform,
  spyOnNodeExec,
  dagOptions,
  makeWorkflowRun,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { getWorkflowEventEmitter, type WorkflowEmitterEvent } from '../../../event-emitter';
import type { DagNode } from '../../../schemas';
import type { IWorkflowStore, PersistedNodeOutput } from '../../../store';

// #2090: loop_group body lifecycle events must carry a namespaced persisted `step_name`
// (`<groupId>.<nodeId>`, composing across nested groups) plus the current `iteration`, while
// the in-process emitter payloads stay raw. Top-level DAG events are unchanged (bare id).
describe('executeDagWorkflow -- loop_group body step_name namespacing (#2090)', () => {
  let testDir: string;

  /** All persisted createWorkflowEvent payloads for a store mock. */
  type PersistedEvent = { event_type: string; step_name?: string; data?: Record<string, unknown> };
  const persistedEvents = (store: IWorkflowStore): PersistedEvent[] =>
    (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.map(
      c => c[0] as PersistedEvent
    );
  const eventsWith = (
    store: IWorkflowStore,
    eventType: string,
    stepName: string
  ): PersistedEvent[] =>
    persistedEvents(store).filter(e => e.event_type === eventType && e.step_name === stepName);

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-lg-ns-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'commands'), { recursive: true });
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('capacity retry audit rows keep the loop-group body path and iteration', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
    try {
      let calls = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        calls++;
        if (calls % 2 === 1) {
          yield {
            type: 'result',
            isError: true,
            errors: ['opaque'],
            failure: { class: 'overloaded', evidence: 'opaque' },
          };
        } else {
          yield { type: 'agent_message_chunk', text: calls === 4 ? 'DONE' : 'still working' };
          yield { type: 'result', sessionId: 'capacity-body' };
        }
      });
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowRun: makeWorkflowRun('capacity-body-run'),
          workflow: {
            name: 'capacity-body',
            nodes: [
              {
                id: 'fixer',
                kind: 'loop_group',
                loop_group: {
                  until: 'DONE',
                  max_iterations: 2,
                  fresh_context: false,
                  nodes: [
                    { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'Do work.' } },
                  ],
                },
              },
            ],
          },
        })
      );
      expect(calls).toBe(4);
      const waits = eventsWith(store, 'node_retry_scheduled', 'fixer.work');
      expect(waits).toHaveLength(2);
      expect(waits.map(wait => wait.data?.iteration)).toEqual([1, 2]);
      expect(waits[0].data).toMatchObject({
        nodeId: 'work',
        retry_class: 'overloaded',
        retry_attempt: 1,
        max_retries: 5,
      });
      expect(persistedEvents(store).some(event => event.step_name === 'work')).toBe(false);
      expect(store.failWorkflowRun).not.toHaveBeenCalled();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it.each(['sh', 'bun'] as const)(
    '%s retry audit rows carry each loop-group body iteration',
    async runtime => {
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 1)) as typeof setTimeout;
      let calls = 0;
      const execSpy = spyOnNodeExec().mockImplementation(async command => {
        if (command === 'git') return { stdout: '', stderr: '' };
        calls++;
        if (calls % 2 === 1)
          throw Object.assign(new Error('opaque failure'), {
            code: 1,
            stdout: '',
            stderr: 'opaque',
          });
        return { stdout: calls === 4 ? 'DONE' : 'still working', stderr: '' };
      });
      try {
        const store = createMockStore();
        await executeDagWorkflow(
          dagOptions({
            deps: createMockDeps(store),
            cwd: testDir,
            workflowRun: makeWorkflowRun('deterministic-body-retry'),
            workflow: {
              name: 'deterministic-body-retry',
              nodes: [
                {
                  id: 'fixer',
                  kind: 'loop_group',
                  loop_group: {
                    until: 'DONE',
                    max_iterations: 2,
                    fresh_context: false,
                    nodes: [
                      {
                        id: 'work',
                        kind: 'exec',
                        runtime,
                        script: 'console.log("work");',
                        retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' },
                      },
                    ],
                  },
                },
              ],
            },
          })
        );
        expect(calls).toBe(4);
        const waits = eventsWith(store, 'node_retry_scheduled', 'fixer.work');
        expect(waits.map(wait => wait.data?.iteration)).toEqual([1, 2]);
        expect(waits.map(wait => wait.data?.retry_attempt)).toEqual([1, 1]);
        expect(store.failWorkflowRun).not.toHaveBeenCalled();
      } finally {
        execSpy.mockRestore();
        globalThis.setTimeout = realSetTimeout;
      }
    }
  );

  it('namespaces body node lifecycle step_name and tags iteration; top-level node stays bare', async () => {
    // `work` (AI) does not emit DONE on iteration 1, emits it on iteration 2 → 2 iterations.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield {
        type: 'agent_message_chunk',
        text: calls === 1 ? 'still working' : 'finished\nDONE',
      };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-ns-run');

    const nodes: DagNode[] = [
      // Top-level bash node — its events must NOT be namespaced and must NOT carry iteration.
      { id: 'setup', kind: 'exec', runtime: 'sh', script: 'echo ready', depends_on: [] },
      {
        id: 'fixer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work, emit DONE when done' },
              depends_on: [],
            },
          ],
        },
        depends_on: ['setup'],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-ns', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(2);

    // Body node events are namespaced `<groupId>.<nodeId>`.
    const bodyStarted = eventsWith(store, 'node_started', 'fixer.work');
    const bodyCompleted = eventsWith(store, 'node_completed', 'fixer.work');
    expect(bodyStarted.length).toBe(2); // one per iteration
    expect(bodyCompleted.length).toBe(2);
    // Each body lifecycle event carries the iteration it ran in.
    expect(bodyStarted.map(e => e.data?.iteration).sort()).toEqual([1, 2]);
    expect(bodyCompleted.map(e => e.data?.iteration).sort()).toEqual([1, 2]);

    // The raw (un-namespaced) body id must NEVER appear as a persisted step_name.
    expect(persistedEvents(store).some(e => e.step_name === 'work')).toBe(false);

    // The group node's OWN events keep the bare group id (they are not body events).
    expect(eventsWith(store, 'node_completed', 'fixer').length).toBeGreaterThanOrEqual(1);
    expect(eventsWith(store, 'loop_iteration_started', 'fixer').length).toBe(2);

    // Top-level node keeps its bare id and carries no `iteration` tag.
    const setupStarted = eventsWith(store, 'node_started', 'setup');
    expect(setupStarted.length).toBe(1);
    expect(setupStarted[0].data?.iteration).toBeUndefined();
    expect(eventsWith(store, 'node_completed', 'setup').length).toBe(1);
  });

  it('composes the prefix across nested loop_groups (<outer>.<inner>.<leaf>)', async () => {
    // Inner group completes in 1 iteration (INNER_DONE); outer completes when review emits
    // OUTER_DONE. Mirrors the EDGE H harness above.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield {
        type: 'agent_message_chunk',
        text: calls === 1 ? 'inner work\nINNER_DONE' : 'outer review\nOUTER_DONE',
      };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-nested-ns');

    const nodes: DagNode[] = [
      {
        id: 'outer',
        kind: 'loop_group',
        loop_group: {
          until: 'OUTER_DONE',
          max_iterations: 3,
          fresh_context: false,
          nodes: [
            {
              id: 'inner',
              kind: 'loop_group',
              loop_group: {
                until: 'INNER_DONE',
                max_iterations: 2,
                fresh_context: false,
                nodes: [
                  {
                    id: 'leaf',
                    kind: 'agent',
                    source: { kind: 'inline', prompt: 'inner work, emit INNER_DONE' },
                    depends_on: [],
                  },
                ],
              },
              depends_on: [],
            },
            {
              id: 'review',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'review, emit OUTER_DONE' },
              depends_on: ['inner'],
            },
          ],
        },
        depends_on: [],
      },
    ];

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-nested-ns', nodes },
        workflowRun,
      })
    );

    expect(calls).toBe(2);

    // Deepest body node composes both enclosing group ids.
    expect(eventsWith(store, 'node_completed', 'outer.inner.leaf').length).toBeGreaterThanOrEqual(
      1
    );
    // The inner group's OWN events are namespaced by the outer group only.
    expect(
      eventsWith(store, 'loop_iteration_started', 'outer.inner').length
    ).toBeGreaterThanOrEqual(1);
    // The outer body's sibling AI node is namespaced by the outer group.
    expect(eventsWith(store, 'node_completed', 'outer.review').length).toBeGreaterThanOrEqual(1);
    // No un-namespaced leaf/review rows leak.
    expect(persistedEvents(store).some(e => e.step_name === 'leaf')).toBe(false);
    expect(persistedEvents(store).some(e => e.step_name === 'review')).toBe(false);
  });

  it('keeps the in-process emitter payload raw (unprefixed nodeId) for body events', async () => {
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'done\nDONE' };
      yield { type: 'result', sessionId: 's-1' };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-emit-raw');

    const captured: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(e => {
      if (e.runId === workflowRun.id) captured.push(e);
    });

    try {
      await executeDagWorkflow(
        dagOptions({
          deps: mockDeps,
          platform,
          conversationId: 'conv-lg',
          cwd: testDir,
          workflow: {
            name: 'lg-emit-raw',
            nodes: [
              {
                id: 'fixer',
                kind: 'loop_group',
                loop_group: {
                  until: 'DONE',
                  max_iterations: 3,
                  fresh_context: false,
                  nodes: [
                    {
                      id: 'work',
                      kind: 'agent',
                      source: { kind: 'inline', prompt: 'do work, emit DONE' },
                      depends_on: [],
                    },
                  ],
                },
                depends_on: [],
              },
            ],
          },
          workflowRun,
        })
      );
    } finally {
      unsubscribe();
    }

    // The live emitter carries the RAW body node id (consumers key off this) — never `fixer.work`.
    const bodyCompleted = captured.filter(
      e => e.type === 'node_completed' && 'nodeId' in e && e.nodeId === 'work'
    );
    expect(bodyCompleted.length).toBeGreaterThanOrEqual(1);
    expect(
      captured.some(e => 'nodeId' in e && (e as { nodeId?: string }).nodeId === 'fixer.work')
    ).toBe(false);
  });

  it('resume: a namespaced body key in priorCompletedNodes cannot skip a top-level node', async () => {
    // Simulate a resume where a prior run's loop_group completed: the map holds the group id
    // AND a namespaced body key. The group must be skipped as a unit (body does NOT re-run),
    // and the un-namespaced body key must NOT be mistaken for the still-pending top-level node.
    let calls = 0;
    mockSendQueryDag.mockImplementation(async function* () {
      calls++;
      yield { type: 'agent_message_chunk', text: 'finalize output' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    const store = createMockStore();
    const mockDeps = createMockDeps(store);
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('lg-resume');

    const priorCompletedNodes = new Map<string, PersistedNodeOutput>([
      ['fixer', { output: 'group output from prior run' }],
      ['fixer.work', { output: 'body output from prior run' }],
    ]);

    const nodes: DagNode[] = [
      {
        id: 'fixer',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 5,
          fresh_context: false,
          nodes: [
            {
              id: 'work',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'do work, emit DONE' },
              depends_on: [],
            },
          ],
        },
        depends_on: [],
      },
      {
        id: 'finalize',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'finalize using $fixer.output' },
        depends_on: ['fixer'],
      },
    ];

    let finalizePrompt = '';
    mockSendQueryDag.mockImplementation(async function* (prompt: string) {
      calls++;
      finalizePrompt = prompt;
      yield { type: 'agent_message_chunk', text: 'finalize output' };
      yield { type: 'result', sessionId: `s-${calls}` };
    });

    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-lg',
        cwd: testDir,
        workflow: { name: 'lg-resume', nodes },
        workflowRun,
        priorCompletedNodes,
      })
    );

    // Only `finalize` executes: the loop_group `fixer` was skipped as a unit (body never
    // re-ran), and the namespaced `fixer.work` key skipped nothing at the top level.
    expect(calls).toBe(1);
    // The skipped group's pre-populated output flows into the still-running downstream node.
    expect(finalizePrompt).toContain('group output from prior run');
    // The group was skipped via its own id, and finalize genuinely ran.
    expect(eventsWith(store, 'node_skipped_prior_success', 'fixer').length).toBe(1);
    expect(eventsWith(store, 'node_completed', 'finalize').length).toBe(1);
  });
});
