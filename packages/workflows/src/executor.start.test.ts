// @archon-test-isolated
import {
  configWith,
  containerBackend,
  makeDeps,
  makePlatform,
  makeRun,
  makeStore,
  makeWorkflow,
  mockCaptureWorkflowInvoked,
  recordedEvents,
  resetExecutorMocks,
  resumeOf,
  sentMessages,
  startWorkflow,
} from './executor/test-utils';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import type { WorkflowDefinition } from './schemas';

/** What a run announces and records as it starts: start events, notices and invocation telemetry. */

beforeEach(resetExecutorMocks);

describe('workflow_started configuration snapshot', () => {
  const startedData = (store: Parameters<typeof recordedEvents>[0]) =>
    recordedEvents(store, 'workflow_started')[0]?.data;

  it('persists the resolved configuration and top-level platform origin', async () => {
    const store = makeStore({
      createWorkflowRun: mock(async () =>
        makeRun({ user_message: 'persisted input', user_id: 'user-1' })
      ),
    });
    const deps: WorkflowDeps = {
      ...makeDeps(store),
      loadConfig: configWith({
        baseBranch: 'config-base',
        tiers: { large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } },
      }),
      getUserAiPrefs: mock(async () => ({ defaultProvider: 'codex' })),
      sealRunConfig: mock(() => ({
        version: 1 as const,
        ciphertext: 'opaque',
        source: { kind: 'http' as const, label: 'inline' },
        keys: ['assistant'],
      })),
    };
    const platform = { ...makePlatform(), getPlatformType: mock(() => 'web') } as IWorkflowPlatform;

    await startWorkflow({
      deps,
      platform,
      cwd: '/tmp/worktree',
      workflow: makeWorkflow({ model: 'large' }),
      message: 'caller input',
      origin: { conversationId: 'db-conv-1', userId: 'user-1' },
      options: {
        baseBranch: 'caller-base',
        baseOverride: 'override-base',
        isolationContext: { branchName: 'feature/snapshot' },
        runConfig: { source: { kind: 'http', label: 'inline' }, layer: { assistant: 'pi' } },
      },
    });

    expect(startedData(store)).toEqual({
      workflowName: 'test-workflow',
      defaultAssistant: 'pi',
      provider: 'codex',
      model: 'gpt-5.5',
      isolationMode: 'worktree',
      baseBranch: 'override-base',
      userId: 'user-1',
      userMessage: 'persisted input',
      origin: 'web',
      transcriptPath: expect.stringMatching(/run-123\.jsonl$/),
    });
  });

  it('persists explicit nulls for an in-place run without a model or user', async () => {
    const store = makeStore();
    await startWorkflow({ store, cwd: '/tmp/folder' });
    expect(startedData(store)).toMatchObject({
      workflowName: 'test-workflow',
      model: null,
      isolationMode: 'in-place',
      userId: null,
      origin: 'test',
    });
    expect(startedData(store)).toHaveProperty('model');
    expect(startedData(store)).toHaveProperty('userId');
  });

  it('classifies a container execution ahead of a worktree context', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      cwd: '/tmp/container',
      options: {
        execContext: { kind: 'container', containerId: 'container-1' },
        container: { envId: 'env', writeBack: 'approve', backend: containerBackend() },
        isolationContext: { branchName: 'feature/snapshot' },
      },
    });
    expect(startedData(store)?.isolationMode).toBe('container');
    expect(startedData(store)?.origin).toBe('test');
  });

  it('uses persisted child-run attribution and input instead of caller values', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      cwd: '/tmp/shared-worktree',
      message: 'transient caller input',
      origin: { conversationId: 'db-conv-1', userId: 'transient-user' },
      options: {
        preCreatedRun: makeRun({
          id: 'child-run',
          user_message: 'persisted child input',
          parent_run_id: 'parent-run',
        }),
      },
    });
    expect(startedData(store)).toMatchObject({
      workflowName: 'test-workflow',
      userId: null,
      userMessage: 'persisted child input',
      origin: 'workflow',
    });
  });
});

// Recorded on the run rather than at the chat dispatch site, so the record does not depend
// on a deliverable notification and CLI- and REST-started runs get it too (#2213, #2781).
describe('start notices recorded on the run', () => {
  it('records the dropped keys of parse warnings', async () => {
    const store = makeStore();
    const warnings = ["Node 'plan': unknown key 'interactive' will be ignored."];
    await startWorkflow({ store, options: { parseWarnings: warnings } });
    expect(recordedEvents(store, 'workflow_parse_warnings')[0]?.data).toEqual({
      workflowName: 'test-workflow',
      warnings,
    });
  });

  it('records parse warnings even when the platform cannot be written to', async () => {
    const store = makeStore();
    const brokenPlatform = {
      sendMessage: mock(() => Promise.reject(new Error('platform down'))),
      getPlatformType: mock(() => 'slack'),
    } as unknown as IWorkflowPlatform;
    // A broken platform may fail the run downstream; irrelevant here.
    await startWorkflow({
      store,
      platform: brokenPlatform,
      options: { parseWarnings: ['dropped a key'] },
    }).catch(() => {});
    expect(recordedEvents(store, 'workflow_parse_warnings')[0]?.data).toMatchObject({
      warnings: ['dropped a key'],
    });
  });

  it('records the composed notice for a deprecated workflow', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      workflow: makeWorkflow({ deprecated: { message: 'Switch to the sdlc pack instead.' } }),
    });
    expect(recordedEvents(store, 'workflow_deprecation_notice')[0]?.data).toEqual({
      workflowName: 'test-workflow',
      notice:
        '⚠️ `test-workflow` is deprecated and will be removed in an upcoming release. ' +
        'Switch to the sdlc pack instead. ' +
        'To keep using this workflow after removal, copy the workflow file into your project ' +
        '`.archon/workflows/` or your global `~/.archon/workflows/`.',
    });
  });

  it('records neither notice for a clean workflow', async () => {
    const store = makeStore();
    await startWorkflow({ store });
    expect(recordedEvents(store, 'workflow_parse_warnings')).toEqual([]);
    expect(recordedEvents(store, 'workflow_deprecation_notice')).toEqual([]);
  });
});

describe('resume announcement', () => {
  it('announces a resume with the count of nodes it skips', async () => {
    const platform = makePlatform();
    await startWorkflow({
      platform,
      options: resumeOf(makeRun({ id: 'prior-run' }), [['node-a', { output: 'a-output' }]]),
    });
    expect(sentMessages(platform)).toContainEqual(
      expect.stringContaining(
        '**Resuming** workflow `test-workflow` — skipping 1 already-completed node(s).'
      )
    );
  });

  it('announces an interactive-loop resume when no node has completed', async () => {
    const platform = makePlatform();
    await startWorkflow({ platform, options: resumeOf(makeRun({ id: 'paused-loop-run' })) });
    expect(sentMessages(platform)).toContainEqual(
      expect.stringContaining('— continuing interactive loop.')
    );
  });

  it('does not announce a resume on a fresh run', async () => {
    const platform = makePlatform();
    await startWorkflow({ platform });
    expect(sentMessages(platform).some(message => message.includes('Resuming'))).toBe(false);
  });
});

describe('workflow_invoked telemetry', () => {
  const invoked = () => mockCaptureWorkflowInvoked.mock.calls.at(-1)?.[0];

  it('reports feature-adoption booleans', async () => {
    const workflow = makeWorkflow({
      persist_sessions: true,
      nodes: [
        {
          id: 'gen',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Generate.' },
          output_format: { type: 'object' },
          mcp: 'mcp.json',
        },
        {
          id: 'iterate',
          depends_on: ['gen'],
          kind: 'loop',
          loop: { prompt: 'Iterate.', until: 'DONE', fresh_context: true },
        },
        {
          id: 'summarize',
          depends_on: ['iterate'],
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Summarize.' },
          output_type: 'report',
        },
      ],
    } as Partial<WorkflowDefinition>);
    await startWorkflow({ workflow });
    expect(mockCaptureWorkflowInvoked).toHaveBeenCalledTimes(1);
    expect(invoked()).toMatchObject({
      usesOutputFormat: true,
      usesOutputType: true,
      usesPersistSession: true,
      usesMcp: true,
      usesFreshContext: true,
      usesSkills: false,
    });
  });

  it('reports usesPersistSession only when a node or composed fan-out may persist', async () => {
    const persistFlag = async (nodes: WorkflowDefinition['nodes']): Promise<unknown> => {
      await startWorkflow({ workflow: makeWorkflow({ persist_sessions: true, nodes }) });
      return invoked()?.usesPersistSession;
    };
    expect(
      await persistFlag([
        { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'x' }, context: 'fresh' },
        { id: 'b', kind: 'exec', runtime: 'sh', script: 'echo hi' },
      ] as WorkflowDefinition['nodes'])
    ).toBe(false);
    expect(
      await persistFlag([
        {
          id: 'fan',
          kind: 'compose_fan_out',
          include: 'persisting-block',
          fan_out: { items: '["a"]', as: 'item', max_parallel: 1, join: 'all_done' },
        },
      ] as WorkflowDefinition['nodes'])
    ).toBe(true);
  });

  it('reports adoption booleans as false for a plain single-prompt workflow', async () => {
    await startWorkflow();
    expect(invoked()).toMatchObject({
      usesOutputFormat: false,
      usesOutputType: false,
      usesPersistSession: false,
      usesMcp: false,
      usesSkills: false,
      usesFreshContext: false,
    });
  });

  it.each(['bundled', undefined] as const)(
    'reports the run and its dispatch source %p',
    async source => {
      await startWorkflow({ options: { source } });
      expect(invoked()?.workflowSource).toBe(source);
      expect(invoked()?.runId).toBe(makeRun().id);
      expect(invoked()?.isChild).toBe(false);
    }
  );
});
