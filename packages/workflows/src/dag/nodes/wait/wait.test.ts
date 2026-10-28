// @archon-test-isolated
import { createEscalationStore } from '../../pause-test-utils';
import { describe, it, expect, beforeEach, afterEach, mock, setSystemTime } from 'bun:test';
import { mkdir } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMockStore,
  mockSendQueryDag,
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  persistedEvents,
} from '../../test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { workflowWaitContextSchema, type WorkflowWaitContext } from '../../../schemas';
import type { IWorkflowStore } from '../../../store';

describe('executeDagWorkflow -- durable wait node', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-wait-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('persists a future wait and returns without invoking a provider', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-wait',
        cwd: testDir,
        workflow: {
          name: 'wait-test',
          nodes: [{ id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledTimes(1);
    const context = (store.pauseWorkflowRunForWait as ReturnType<typeof mock>).mock.calls[0]?.[1];
    expect(context).toMatchObject({ nodeId: 'delay', kind: 'time' });
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('surfaces the pause failure when the status read after it fails too', async () => {
    const store = createMockStore();
    store.pauseWorkflowRunForWait = mock(async () => {
      store.getWorkflowRunStatus.mockRejectedValueOnce(new Error('status read failed'));
      throw new Error('pause write failed');
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflow: {
          name: 'wait-test',
          nodes: [{ id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } }],
        },
        workflowRun: makeWorkflowRun(),
      })
    );
    const failures = JSON.stringify([
      ...store.failWorkflowRun.mock.calls,
      ...persistedEvents(store).filter(e => e.event_type === 'node_failed'),
    ]);
    expect(failures).toContain('pause write failed');
    expect(failures).not.toContain('status read failed');
  });

  for (const wait of [
    { duration_ms: 60_000 },
    { until: '$INPUTS.resume_at' },
    { event: 'ready', deadline_ms: 60_000 },
  ]) {
    it(`gives repeated deadline waits distinct occurrences even at the same instant (${JSON.stringify(wait)})`, async () => {
      setSystemTime(new Date('2026-08-24T10:00:00.000Z'));
      try {
        const store = createMockStore();
        const pause = mock<IWorkflowStore['pauseWorkflowRunForWait']>(async () => {});
        store.pauseWorkflowRunForWait = pause;
        const options = dagOptions({
          deps: createMockDeps(store),
          conversationId: 'conv-wait',
          cwd: testDir,
          workflow: { name: 'wait-test', nodes: [{ id: 'delay', kind: 'wait', wait }] },
          workflowRun: makeWorkflowRun('wait-occurrence', {
            metadata: { inputs: { resume_at: '2026-08-24T10:01:00.000Z' } },
          }),
        });
        await executeDagWorkflow(options);
        await executeDagWorkflow(options);
        const calls = pause.mock.calls;
        const first = calls[0]?.[1];
        const second = calls[1]?.[1];
        expect(first?.pauseId).toEqual(expect.any(String));
        expect(second?.pauseId).toEqual(expect.any(String));
        expect(second?.pauseId).not.toBe(first?.pauseId);
        expect(first).toMatchObject({ resumeAt: '2026-08-24T10:01:00.000Z' });
        expect(second).toMatchObject({ resumeAt: '2026-08-24T10:01:00.000Z' });
        const persisted = { ...second };
        await executeDagWorkflow({
          ...options,
          workflowRun: {
            ...options.workflowRun,
            metadata: { wait: { ...persisted, futureField: true } },
          },
        });
        expect(calls[2]?.[1]).toEqual(persisted);
        expect(workflowWaitContextSchema.safeParse(calls[2]?.[1]).success).toBe(true);
        expect(calls[2]?.[2]).toEqual({ kind: 'continued' });
      } finally {
        setSystemTime();
      }
    });
  }

  it('resolves a child workflow input used as an absolute wait timestamp', async () => {
    const store = createMockStore();
    const resumeAt = '2099-08-24T11:00:00.000Z';

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-wait-input',
        cwd: testDir,
        workflow: {
          name: 'wait-input-test',
          nodes: [{ id: 'delay', kind: 'wait', wait: { until: '$INPUTS.resume_at' } }],
        },
        workflowRun: makeWorkflowRun('wait-input', {
          metadata: { inputs: { resume_at: resumeAt } },
        }),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'wait-input',
      expect.objectContaining({ owner: 'node', nodeId: 'delay', resumeAt }),
      { kind: 'started', stepName: 'delay' }
    );
  });

  it('resolves a child workflow input embedded in an event name', async () => {
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-wait-input',
        cwd: testDir,
        workflow: {
          name: 'wait-event-input-test',
          nodes: [
            {
              id: 'deploy',
              kind: 'wait',
              wait: { event: 'deploy:$INPUTS.channel', deadline_ms: 60_000 },
            },
          ],
        },
        workflowRun: makeWorkflowRun('wait-event-input', {
          metadata: { inputs: { channel: 'prod' } },
        }),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'wait-event-input',
      expect.objectContaining({ owner: 'node', nodeId: 'deploy', event: 'deploy:prod' }),
      { kind: 'started', stepName: 'deploy' }
    );
  });

  it('pauses an attention wait with a rendered message, a pause id and its form', async () => {
    const store = createMockStore();
    const platform = createMockPlatform();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-attention',
        cwd: testDir,
        workflow: {
          name: 'attention-wait-test',
          nodes: [
            {
              id: 'rerun-ci',
              kind: 'wait',
              wait: { attention: 'Re-run $INPUTS.check, then resume.' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-wait', {
          metadata: { inputs: { check: 'windows tests' } },
        }),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'attention-wait',
      {
        owner: 'node',
        nodeId: 'rerun-ci',
        kind: 'attention',
        waitingSince: expect.any(String),
        message: 'Re-run windows tests, then resume.',
        pauseId: expect.any(String),
        form: 'message',
      },
      { kind: 'started', stepName: 'rerun-ci' }
    );
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(call =>
      String(call[1])
    );
    expect(messages.join('\n')).toContain('Workflow run `attention-wait` needs attention');
    expect(messages.join('\n')).toContain('Re-run windows tests, then resume.');
    expect(messages.join('\n')).toContain('approve attention-wait <your answer>');
  });

  it('keeps an attention pause paused when its notification cannot be delivered', async () => {
    const store = createEscalationStore('attention-delivery-failed');
    const platform = createMockPlatform();
    platform.sendMessage.mockImplementation(async () => {
      throw new Error('request timed out');
    });

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-attention-failed',
        cwd: testDir,
        workflow: {
          name: 'attention-delivery-failed-test',
          nodes: [
            {
              id: 'rerun-ci',
              kind: 'wait',
              wait: { attention: 'Re-run CI, then resume.' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-delivery-failed'),
      })
    );

    expect(store.getState()).toMatchObject({
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          message: 'Re-run CI, then resume.',
        },
      },
    });
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'attention-delivery-failed',
      event_type: 'pause_notice_undelivered',
      step_name: 'rerun-ci',
      data: { nodeId: 'rerun-ci', occurrence: expect.any(String), platform: 'test' },
    });
    expect(store.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'node_failed' })
    );
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
  });

  it('completes a wait paused before answers existed on a bare resume, with empty text', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'rerun-ci',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Re-run CI, then resume.',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-resume',
        cwd: testDir,
        workflow: {
          name: 'attention-resume-test',
          nodes: [{ id: 'rerun-ci', kind: 'wait', wait: { attention: 'unused on resume' } }],
        },
        workflowRun: makeWorkflowRun('attention-resume', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalledWith(
      'attention-resume',
      persisted,
      expect.objectContaining({
        stepName: 'rerun-ci',
        result: expect.objectContaining({ status: 'satisfied' }),
        answer: { text: '' },
      })
    );
  });

  it('completes an answered select wait with its answer as typed output', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Which base?',
      pauseId: 'ask-1',
      form: 'select',
      options: [{ id: 'use-main' }, { id: 'use-dev' }],
      answer: { decision: 'use-dev', text: 'dev is ahead' },
      answeredVia: 'cli',
      answeredAt: '2026-08-24T10:05:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-answered',
        cwd: testDir,
        workflow: {
          name: 'attention-answered-test',
          nodes: [
            {
              id: 'ask',
              kind: 'wait',
              wait: { attention: 'Which base?', form: 'select', options: [{ id: 'use-main' }] },
            },
            {
              id: 'after',
              kind: 'exec',
              runtime: 'sh',
              script: 'printf "%s" "$ask.output.decision"',
              depends_on: ['ask'],
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-answered', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalledWith(
      'attention-answered',
      persisted,
      expect.objectContaining({
        stepName: 'ask',
        answer: { decision: 'use-dev', text: 'dev is ahead' },
      })
    );
    const afterCompleted = store.persistWorkflowEvent.mock.calls
      .map(([event]) => event)
      .find(event => event.step_name === 'after' && event.event_type === 'node_completed');
    expect(JSON.stringify(afterCompleted?.data)).toContain('use-dev');
  });

  // An answer belongs to the question it answered. When a dependency re-executes on
  // the resume that applies the answer, the question the wait would ask now is not the
  // one that was answered, so the stored answer must not complete the wait.
  it('asks again instead of applying an answer when a dependency re-ran on resume', async () => {
    const store = createMockStore();
    const platform = createMockPlatform();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Which base? prior says old',
      pauseId: 'ask-1',
      form: 'select',
      options: [{ id: 'use-main' }, { id: 'use-dev' }],
      answer: { decision: 'use-dev', text: 'dev is ahead' },
      answeredVia: 'cli',
      answeredAt: '2026-08-24T10:05:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-attention-stale',
        cwd: testDir,
        workflow: {
          name: 'attention-stale-test',
          nodes: [
            { id: 'prior', kind: 'exec', runtime: 'sh', script: 'printf new' },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['prior'],
              wait: {
                attention: 'Which base? prior says $prior.output',
                form: 'select',
                options: [{ id: 'use-main' }, { id: 'use-dev' }],
              },
            },
            {
              id: 'after',
              kind: 'exec',
              runtime: 'sh',
              script: 'printf "%s" "$ask.output.decision"',
              depends_on: ['ask'],
            },
          ],
        },
        // The prior pass completed nothing the wait depends on, so `prior` runs fresh.
        priorCompletedNodes: new Map([['unrelated', { output: 'x' }]]),
        workflowRun: makeWorkflowRun('attention-stale', { metadata: { wait: persisted } }),
      })
    );

    expect(store.clearWorkflowWaitContext).not.toHaveBeenCalled();
    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'attention-stale',
      expect.objectContaining({
        kind: 'attention',
        message: 'Which base? prior says new',
        form: 'select',
      }),
      { kind: 'started', stepName: 'ask' }
    );
    const pausedWith = store.pauseWorkflowRunForWait.mock.calls[0]?.[1] as WorkflowWaitContext;
    expect(pausedWith.kind === 'attention' && pausedWith.answer).toBeFalsy();
    expect(pausedWith.kind === 'attention' && pausedWith.pauseId).not.toBe('ask-1');
    expect(pausedWith.kind === 'attention' && pausedWith.reaskedFrom).toBe('ask-1');
    const notices = platform.sendMessage.mock.calls.map(([, text]) => String(text));
    expect(
      notices.some(text => text.includes('earlier answer was discarded because prior changed'))
    ).toBe(true);
    const afterRan = store.persistWorkflowEvent.mock.calls
      .map(([event]) => event)
      .some(event => event.step_name === 'after' && event.event_type === 'node_completed');
    expect(afterRan).toBe(false);
  });

  it('applies an answer on resume when every dependency replays its prior success', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Which base? prior says old',
      pauseId: 'ask-1',
      form: 'select',
      options: [{ id: 'use-main' }, { id: 'use-dev' }],
      answer: { decision: 'use-dev', text: 'dev is ahead' },
      answeredVia: 'cli',
      answeredAt: '2026-08-24T10:05:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-replayed',
        cwd: testDir,
        workflow: {
          name: 'attention-replayed-test',
          nodes: [
            { id: 'prior', kind: 'exec', runtime: 'sh', script: 'printf new' },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['prior'],
              wait: {
                attention: 'Which base? prior says $prior.output',
                form: 'select',
                options: [{ id: 'use-main' }, { id: 'use-dev' }],
              },
            },
          ],
        },
        priorCompletedNodes: new Map([['prior', { output: 'old' }]]),
        workflowRun: makeWorkflowRun('attention-replayed', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalledWith(
      'attention-replayed',
      persisted,
      expect.objectContaining({ answer: { decision: 'use-dev', text: 'dev is ahead' } })
    );
  });

  // An always_run producer re-executes on every resume, so its output can differ each
  // pass. When the question the wait renders is unchanged, the answer still applies.
  it('applies an answer when an always_run dependency changed but the question did not', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Which base?',
      pauseId: 'ask-1',
      form: 'select',
      options: [{ id: 'use-main' }, { id: 'use-dev' }],
      answer: { decision: 'use-dev', text: 'dev is ahead' },
      answeredVia: 'cli',
      answeredAt: '2026-08-24T10:05:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-always-run',
        cwd: testDir,
        workflow: {
          name: 'attention-always-run-test',
          nodes: [
            { id: 'stamp', kind: 'exec', runtime: 'sh', script: 'date +%s%N', always_run: true },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['stamp'],
              wait: {
                attention: 'Which base?',
                form: 'select',
                options: [{ id: 'use-main' }, { id: 'use-dev' }],
              },
            },
          ],
        },
        priorCompletedNodes: new Map([['stamp', { output: '1' }]]),
        workflowRun: makeWorkflowRun('attention-always-run', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalledWith(
      'attention-always-run',
      persisted,
      expect.objectContaining({ answer: { decision: 'use-dev', text: 'dev is ahead' } })
    );
  });

  // A question built from a value that changes on every resume would otherwise be asked
  // forever. An answer to a question already re-asked once applies.
  it('applies the answer to a re-asked question even when the question changed again', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Approve at stamp 1?',
      pauseId: 'ask-2',
      reaskedFrom: 'ask-1',
      form: 'approval',
      answer: { decision: 'approve', text: '' },
      answeredVia: 'cli',
      answeredAt: '2026-08-24T10:05:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-reasked',
        cwd: testDir,
        workflow: {
          name: 'attention-reasked-test',
          nodes: [
            { id: 'stamp', kind: 'exec', runtime: 'sh', script: 'printf 2', always_run: true },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['stamp'],
              wait: { attention: 'Approve at stamp $stamp.output?', form: 'approval' },
            },
          ],
        },
        priorCompletedNodes: new Map([['stamp', { output: '1' }]]),
        workflowRun: makeWorkflowRun('attention-reasked', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalled();
  });

  it('pauses an unanswered select wait again on a bare resume', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-08-24T10:00:00.000Z',
      message: 'Which base?',
      pauseId: 'ask-1',
      form: 'select',
      options: [{ id: 'use-main' }],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-attention-unanswered',
        cwd: testDir,
        workflow: {
          name: 'attention-unanswered-test',
          nodes: [
            {
              id: 'ask',
              kind: 'wait',
              wait: { attention: 'Which base?', form: 'select', options: [{ id: 'use-main' }] },
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-unanswered', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith('attention-unanswered', persisted, {
      kind: 'continued',
    });
    expect(store.clearWorkflowWaitContext).not.toHaveBeenCalled();
  });

  it('resolves referenced options when the wait pauses', async () => {
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        conversationId: 'conv-attention-options',
        cwd: testDir,
        workflow: {
          name: 'attention-options-test',
          nodes: [
            {
              id: 'plan',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"options":[{"id":"use-main","label":"Main"},{"id":"use-dev"}]}'`,
              output_format: {
                type: 'object',
                properties: {
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { id: { type: 'string' }, label: { type: 'string' } },
                      required: ['id'],
                    },
                  },
                },
                required: ['options'],
              },
            },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['plan'],
              wait: { attention: 'Which base?', form: 'select', options: '$plan.output.options' },
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-options'),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'attention-options',
      expect.objectContaining({
        kind: 'attention',
        form: 'select',
        options: [{ id: 'use-main', label: 'Main' }, { id: 'use-dev' }],
      }),
      { kind: 'started', stepName: 'ask' }
    );
  });

  it('resolves label values when the wait pauses', async () => {
    const store = createMockStore();

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform: createMockPlatform(),
        conversationId: 'conv-attention-labels',
        cwd: testDir,
        workflow: {
          name: 'attention-labels-test',
          nodes: [
            {
              id: 'plan',
              kind: 'exec',
              runtime: 'sh',
              script: `printf '%s' '{"cause":"other"}'`,
              output_format: {
                type: 'object',
                properties: { cause: { type: 'string' } },
                required: ['cause'],
              },
            },
            {
              id: 'ask',
              kind: 'wait',
              depends_on: ['plan'],
              wait: {
                attention: 'CI is red. Retry?',
                labels: { ci: '$plan.output.cause', area: 'delivery' },
              },
            },
          ],
        },
        workflowRun: makeWorkflowRun('attention-labels'),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith(
      'attention-labels',
      expect.objectContaining({
        kind: 'attention',
        labels: { ci: 'other', area: 'delivery' },
      }),
      { kind: 'started', stepName: 'ask' }
    );
  });

  it('fails the wait, naming the producer, when referenced options are invalid', async () => {
    for (const [name, value] of [
      ['empty', '[]'],
      ['duplicate', '[{"id":"a"},{"id":"a"}]'],
      ['not kebab-case', '[{"id":"Use Main"}]'],
      ['wrong shape', '["a"]'],
    ] as const) {
      const store = createMockStore();
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          platform: createMockPlatform(),
          conversationId: 'conv-attention-bad-options',
          cwd: testDir,
          workflow: {
            name: 'attention-bad-options-test',
            nodes: [
              {
                id: 'plan',
                kind: 'exec',
                runtime: 'sh',
                script: `printf '%s' '{"options":${value}}'`,
              },
              {
                id: 'ask',
                kind: 'wait',
                depends_on: ['plan'],
                wait: { attention: 'Which?', form: 'select', options: '$plan.output.options' },
              },
            ],
          },
          workflowRun: makeWorkflowRun(`attention-bad-options-${name.replace(/ /g, '-')}`),
        })
      );
      expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      const failed = store.createWorkflowEvent.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'node_failed' && event.step_name === 'ask');
      expect({ name, error: String(failed?.data?.error) }).toMatchObject({
        name,
        error: expect.stringContaining("from 'plan' are not a valid option list"),
      });
    }
  });

  it('completes an expired event wait with typed output on resume', async () => {
    const store = createMockStore();
    const deps = createMockDeps(store);
    const workflowRun = makeWorkflowRun('wait-resume', {
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'ci',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-23T00:00:00.000Z',
          resumeAt: '2026-08-24T00:00:00.000Z',
        },
      },
    });
    await executeDagWorkflow(
      dagOptions({
        deps,
        conversationId: 'conv-wait',
        cwd: testDir,
        workflow: {
          name: 'wait-expiry-test',
          nodes: [
            { id: 'ci', kind: 'wait', wait: { event: 'checks.complete', deadline_ms: 60_000 } },
          ],
        },
        workflowRun,
      })
    );
    expect(store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(store.clearWorkflowWaitContext).toHaveBeenCalledWith(
      'wait-resume',
      workflowRun.metadata.wait,
      expect.objectContaining({
        stepName: 'ci',
        result: expect.objectContaining({ status: 'expired' }),
      })
    );
  });

  it('re-pauses an early manual resume against the original absolute time', async () => {
    const store = createMockStore();
    const persisted: WorkflowWaitContext = {
      owner: 'node',
      nodeId: 'delay',
      kind: 'time',
      waitingSince: '2026-08-24T10:00:00.000Z',
      resumeAt: '2099-08-24T11:00:00.000Z',
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        conversationId: 'conv-wait',
        cwd: testDir,
        workflow: {
          name: 'wait-early-resume-test',
          nodes: [{ id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } }],
        },
        workflowRun: makeWorkflowRun('wait-early-resume', { metadata: { wait: persisted } }),
      })
    );

    expect(store.pauseWorkflowRunForWait).toHaveBeenCalledWith('wait-early-resume', persisted, {
      kind: 'continued',
    });
  });

  it('tolerates cancellation that wins the wait pause CAS', async () => {
    const store = createMockStore();
    const platform = createMockPlatform();
    let pauseAttempted = false;
    store.pauseWorkflowRunForWait = mock(async () => {
      expect(
        store.persistWorkflowEvent.mock.calls
          .map(([event]) => event)
          .filter(event => event.step_name === 'delay')
          .map(event => event.event_type)
      ).toEqual(['node_started']);
      pauseAttempted = true;
      throw new Error('Workflow run not found or not in running state');
    });
    store.getWorkflowRunStatus = mock(async () => (pauseAttempted ? 'cancelled' : 'running'));

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        platform,
        conversationId: 'conv-wait-cancelled',
        cwd: testDir,
        workflow: {
          name: 'wait-cancelled-race',
          nodes: [{ id: 'delay', kind: 'wait', wait: { attention: 'Complete the action.' } }],
        },
        workflowRun: makeWorkflowRun('wait-cancelled'),
      })
    );

    const events = store.createWorkflowEvent.mock.calls.map(call => call[0].event_type);
    expect(events).not.toContain('node_failed');
    expect(store.failWorkflowRun).not.toHaveBeenCalled();
    expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls.map(call =>
      String(call[1])
    );
    expect(messages.join('\n')).not.toContain('needs attention');
  });
});
