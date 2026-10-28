// @archon-test-isolated
import {
  configWith,
  dagCall,
  logged,
  makeDeps,
  makePlatform,
  makeRun,
  makeStore,
  makeWorkflow,
  mockExecuteDagWorkflow,
  resetExecutorMocks,
  resumeOf,
  sentMessages,
  startWorkflow,
  WS,
} from './executor/test-utils';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { join } from 'path';
import type { WorkflowDeps } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import { prepareRunAiConfiguration } from './run-preflight';
import type { WorkflowRun } from './schemas';
import type { WorkflowRunConfigMetadata } from './schemas/run-config';
import type { IWorkflowStore } from './store';

/** Which provider, model, tiers and config layer a run executes with, and what it records of them. */

beforeEach(resetExecutorMocks);

const hasNoSnapshotWrite = (
  updateRun: ReturnType<typeof mock<IWorkflowStore['updateWorkflowRun']>>
) =>
  updateRun.mock.calls.every(
    ([, update]) => !Object.hasOwn(update.metadata ?? {}, 'ai_configuration')
  );

const overrideLarge = (ref: string): ExecuteWorkflowOptions['modelOverrideLayer'] => ({
  kind: 'raw',
  overrides: { tiers: { large: ref } },
});

describe('recorded launch AI configuration', () => {
  it.each(['pending', 'running'] as const)(
    'restores %s rows despite a different caller-prepared configuration',
    async status => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
      const deps = makeDeps(makeStore({ updateWorkflowRun: updateRun }));
      const workflow = makeWorkflow();
      deps.loadConfig = configWith({
        assistant: 'codex',
        assistants: { claude: {}, codex: { model: 'gpt-5.6-sol', webSearchMode: 'disabled' } },
      });
      const launch = await prepareRunAiConfiguration(deps, workflow, '/launch');
      deps.loadConfig = configWith({
        assistants: {
          claude: { model: 'opus' },
          codex: { model: 'changed', webSearchMode: 'live' },
        },
      });
      const different = await prepareRunAiConfiguration(deps, workflow, '/current');
      const run = makeRun({
        status,
        metadata: { ai_configuration: JSON.parse(JSON.stringify(launch.aiConfigurationSnapshot)) },
      });
      await startWorkflow({
        deps,
        workflow,
        options: {
          ...(status === 'running' ? resumeOf(run) : { preCreatedRun: run }),
          preparedAiConfiguration: different,
        },
      });
      expect(dagCall()?.workflowProvider).toBe('codex');
      expect(dagCall()?.workflowModel).toBe('gpt-5.6-sol');
      // Native settings stay live; only the launch's AI choices are restored.
      expect(dagCall()?.config.assistants.codex).toEqual({
        model: 'gpt-5.6-sol',
        webSearchMode: 'live',
      });
      expect(hasNoSnapshotWrite(updateRun)).toBe(true);
      expect(run.metadata.ai_configuration).toEqual(launch.aiConfigurationSnapshot);
    }
  );

  it.each(['adopt', 'supersede'] as const)('%s uses the correct AI owner', async mode => {
    const deps = makeDeps();
    const workflow = makeWorkflow();
    deps.loadConfig = configWith({
      assistant: 'codex',
      assistants: { claude: {}, codex: { model: 'launch-model' } },
    });
    const launch = await prepareRunAiConfiguration(deps, workflow, '/tmp');
    const ancestor = makeRun({
      id: 'ancestor',
      status: 'completed',
      user_id: 'old-actor',
      output_root: join(WS, 'workspaces', 'acme', 'widget'),
      metadata: { ai_configuration: launch.aiConfigurationSnapshot },
    });
    deps.store.getWorkflowRun = mock(async id =>
      id === 'ancestor' ? ancestor : makeRun({ status: 'completed' })
    );
    deps.loadConfig = configWith({ assistants: { claude: { model: 'opus' }, codex: {} } });
    const different = await prepareRunAiConfiguration(deps, workflow, '/tmp');
    const result = await startWorkflow({
      deps,
      workflow,
      origin: { conversationId: 'db-conv-1', userId: 'new-actor' },
      options: {
        adoptedFromRunId: 'ancestor',
        continuationMode: mode,
        preparedAiConfiguration: different,
      },
    });
    expect(result.success).toBe(true);
    expect(dagCall()?.workflowProvider).toBe(mode === 'adopt' ? 'codex' : 'claude');
    expect(dagCall()?.workflowModel).toBe(mode === 'adopt' ? 'launch-model' : 'opus');
    expect(deps.store.createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ origin: expect.objectContaining({ userId: 'new-actor' }) })
    );
  });

  it('direct adoption rejects explicit AI overrides before dispatch', async () => {
    const deps = makeDeps();
    const workflow = makeWorkflow();
    const launch = await prepareRunAiConfiguration(deps, workflow, '/tmp');
    deps.store.getWorkflowRun = mock(async () =>
      makeRun({ metadata: { ai_configuration: launch.aiConfigurationSnapshot } })
    );
    await expect(
      startWorkflow({
        deps,
        workflow,
        options: {
          adoptedFromRunId: 'ancestor',
          modelOverrideLayer: overrideLarge('claude/opus'),
          preparedAiConfiguration: launch,
        },
      })
    ).rejects.toThrow('Cannot override AI configuration');
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('records fresh policy and never backfills a legacy continuation', async () => {
    const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
    const createRun = mock<IWorkflowStore['createWorkflowRun']>(async () => makeRun());
    const deps = makeDeps(
      makeStore({ updateWorkflowRun: updateRun, createWorkflowRun: createRun })
    );
    await startWorkflow({ deps });
    expect(createRun.mock.calls[0]?.[0].metadata?.ai_configuration).toMatchObject({
      version: 1,
      assistant: 'claude',
    });
    updateRun.mockClear();
    await startWorkflow({ deps, options: resumeOf(makeRun()) });
    expect(hasNoSnapshotWrite(updateRun)).toBe(true);
  });

  it('legacy continuation still accepts caller-prepared values without backfilling', async () => {
    const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
    const deps = makeDeps(makeStore({ updateWorkflowRun: updateRun }));
    const workflow = makeWorkflow();
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/launch');
    deps.loadConfig = configWith({ assistant: 'codex' });
    await startWorkflow({
      deps,
      workflow,
      options: { ...resumeOf(makeRun()), preparedAiConfiguration: prepared },
    });
    expect(dagCall()?.workflowProvider).toBe('claude');
    expect(hasNoSnapshotWrite(updateRun)).toBe(true);
  });

  it('rejects corrupt recorded policy before dispatch even with prepared values', async () => {
    const deps = makeDeps();
    const workflow = makeWorkflow();
    const prepared = await prepareRunAiConfiguration(deps, workflow, '/tmp');
    await expect(
      startWorkflow({
        deps,
        workflow,
        options: {
          ...resumeOf(makeRun({ metadata: { ai_configuration: { version: 2 } } })),
          preparedAiConfiguration: prepared,
        },
      })
    ).rejects.toThrow('Invalid recorded run AI configuration');
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('stops a pending run before dispatch when snapshot persistence fails', async () => {
    const store = makeStore({
      updateWorkflowRun: mock(async (_id, update) => {
        if (Object.hasOwn(update.metadata ?? {}, 'ai_configuration'))
          throw new Error('write failed');
      }),
    });
    const result = await startWorkflow({
      store,
      options: { preCreatedRun: makeRun({ status: 'pending' }) },
    });
    expect(result.success).toBe(false);
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    expect(store.failWorkflowRun).toHaveBeenCalled();
  });
});

describe('model/provider resolution', () => {
  // The model string is forwarded verbatim to whichever SDK the resolved provider names;
  // the SDK decides whether it accepts it.
  it.each([
    ['falls back to the config assistant', {}, 'claude', undefined],
    [
      'passes workflow.model through when provider is unset',
      { model: 'sonnet' },
      'claude',
      'sonnet',
    ],
    [
      'never re-routes provider on model name',
      { provider: 'codex', model: 'sonnet' },
      'codex',
      'sonnet',
    ],
  ] as const)('%s', async (_label, overrides, provider, model) => {
    await startWorkflow({ workflow: makeWorkflow(overrides) });
    expect(dagCall()?.workflowProvider).toBe(provider);
    if (model) expect(dagCall()?.workflowModel).toBe(model);
  });

  it('throws when workflow.provider is not a registered provider', async () => {
    await expect(
      startWorkflow({ workflow: makeWorkflow({ provider: 'claud', model: 'sonnet' }) })
    ).rejects.toThrow(/Unknown provider: 'claud'/);
  });

  it('resolves top-level workflow tier refs before calling the DAG executor', async () => {
    const preset = { provider: 'codex', model: 'gpt-5.5', effort: 'high' } as const;
    await startWorkflow({
      deps: { ...makeDeps(), loadConfig: configWith({ tiers: { large: preset } }) },
      workflow: makeWorkflow({ model: 'large' }),
    });
    expect(dagCall()?.workflowProvider).toBe('codex');
    expect(dagCall()?.workflowModel).toBe('gpt-5.5');
    expect(dagCall()?.aiProfile).toEqual(
      expect.objectContaining({ aliases: expect.objectContaining({ large: preset }) })
    );
    expect(dagCall()?.workflowPreset).toEqual(preset);
  });
});

describe('per-user AI prefs', () => {
  const withPrefs = (getUserAiPrefs: WorkflowDeps['getUserAiPrefs'], deps = makeDeps()) =>
    startWorkflow({
      deps: { ...deps, getUserAiPrefs },
      workflow: makeWorkflow({ model: 'large' }),
      origin: { conversationId: 'db-conv-1', userId: 'user-1' },
    });

  it('applies per-user AI prefs as the highest-precedence resolver layer', async () => {
    const getUserAiPrefs = mock(async () => ({
      tiers: { large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' as const } },
    }));
    await withPrefs(getUserAiPrefs, {
      ...makeDeps(),
      loadConfig: configWith({ tiers: { large: { provider: 'claude', model: 'opus' } } }),
    });
    expect(getUserAiPrefs).toHaveBeenCalledWith('user-1');
    expect(dagCall()?.workflowProvider).toBe('codex');
    expect(dagCall()?.workflowModel).toBe('gpt-5.5');
  });

  it('does not consult per-user AI prefs without a userId (solo unchanged)', async () => {
    const getUserAiPrefs = mock(async () => ({}));
    await startWorkflow({ deps: { ...makeDeps(), getUserAiPrefs } });
    expect(getUserAiPrefs).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a throwing prefs lookup',
      async () => {
        throw new Error('db down');
      },
    ],
    // An alias without the '@' prefix makes buildAiProfile throw.
    [
      'structurally invalid prefs',
      async () => ({ aliases: { fast: { provider: 'claude', model: 'haiku' } } }),
    ],
  ])('%s degrades to config-only and the run still starts', async (_label, prefs) => {
    await withPrefs(mock(prefs));
    expect(dagCall()?.workflowProvider).toBe('claude');
  });

  it("per-user default provider rebases tier defaults for the run's profile", async () => {
    // No tiers configured anywhere → built-in tier defaults follow the user's provider.
    await withPrefs(mock(async () => ({ defaultProvider: 'codex' })));
    expect(dagCall()?.workflowProvider).toBe('codex');
  });
});

describe('run-scoped model bindings (#2481)', () => {
  const large = makeWorkflow({ model: 'large' });

  it('rebinding large changes only large and records the effective profile', async () => {
    const createRun = mock<IWorkflowStore['createWorkflowRun']>(async () => makeRun());
    await startWorkflow({
      store: makeStore({ createWorkflowRun: createRun }),
      workflow: large,
      options: { modelOverrideLayer: overrideLarge('openai/gpt-5.6') },
    });
    expect(dagCall()?.workflowProvider).toBe('pi');
    expect(dagCall()?.workflowModel).toBe('openai/gpt-5.6');
    const profile = dagCall()?.aiProfile;
    expect(profile?.aliases.large).toEqual({ provider: 'pi', model: 'openai/gpt-5.6' });
    expect(profile?.aliases.small?.provider).toBe('claude');
    expect(profile?.aliases.medium?.provider).toBe('claude');
    expect(logged('workflow_provider_resolved')).toContainEqual(
      expect.objectContaining({ providerSource: 'run-override' })
    );
    expect(createRun.mock.calls[0]?.[0].metadata?.model_bindings).toMatchObject({
      overrides: { tiers: { large: { provider: 'pi', model: 'openai/gpt-5.6' } } },
      effective: { aliases: { large: { provider: 'pi', model: 'openai/gpt-5.6' } } },
    });
  });

  it('merges effective bindings onto a pre-created fresh run before DAG execution', async () => {
    const store = makeStore();
    await startWorkflow({
      store,
      workflow: large,
      options: {
        preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }),
        modelOverrideLayer: overrideLarge('codex/gpt-5.6-sol'),
      },
    });
    expect(store.updateWorkflowRun).toHaveBeenCalledWith(
      'pending-run',
      expect.objectContaining({
        metadata: expect.objectContaining({ model_bindings: expect.any(Object) }),
      })
    );
    expect(dagCall()?.workflowProvider).toBe('codex');
  });

  it('fails a pre-created run when its effective bindings cannot be recorded', async () => {
    const store = makeStore({
      updateWorkflowRun: mock(async () => {
        throw new Error('database unavailable');
      }),
    });
    const result = await startWorkflow({
      store,
      workflow: large,
      options: {
        preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }),
        modelOverrideLayer: overrideLarge('codex/gpt-5.6-sol'),
      },
    });
    const error = 'Database error recording workflow invocation settings';
    expect(result).toEqual({ success: false, workflowRunId: 'pending-run', error });
    expect(store.failWorkflowRun).toHaveBeenCalledWith('pending-run', error);
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('restores the persisted sparse layer on resume and refuses a new one', async () => {
    const run = makeRun({
      id: 'resume-model-run',
      metadata: {
        model_bindings: {
          overrides: { tiers: { large: { provider: 'pi', model: 'openai/gpt-5.6' } } },
          effective: {
            defaultProvider: 'claude',
            aliases: {
              small: { provider: 'claude', model: 'haiku' },
              medium: { provider: 'claude', model: 'sonnet' },
              large: { provider: 'pi', model: 'openai/gpt-5.6' },
            },
          },
        },
      },
    });
    await startWorkflow({ workflow: large, options: resumeOf(run) });
    expect(dagCall()?.workflowProvider).toBe('pi');
    expect(dagCall()?.workflowModel).toBe('openai/gpt-5.6');

    await expect(
      startWorkflow({
        workflow: large,
        options: { ...resumeOf(run), modelOverrideLayer: overrideLarge('codex/gpt-5.6-sol') },
      })
    ).rejects.toThrow(/Cannot supply model overrides when resuming/);
  });

  const bindingsRun = (overrides: object, aliases: object): WorkflowRun =>
    makeRun({
      id: 'resume-binding-run',
      metadata: {
        model_bindings: { overrides, effective: { defaultProvider: 'claude', aliases } },
      },
    });
  const opencodeEffort = {
    provider: 'opencode',
    model: 'anthropic/claude-sonnet-4-6',
    effort: 'ultra',
  };
  const retiredThinking = {
    provider: 'copilot',
    model: 'gpt-5.6',
    thinking: { type: 'enabled', budgetTokens: 1_000 },
  };
  const removedProvider = { provider: 'removed-provider', model: 'legacy-model' };

  it.each([
    [
      'persisted effort is ineffective',
      bindingsRun(
        { tiers: { large: opencodeEffort } },
        {
          small: { provider: 'claude', model: 'haiku' },
          medium: { provider: 'claude', model: 'sonnet' },
          large: opencodeEffort,
        }
      ),
      /cannot apply effort to provider 'opencode'/,
    ],
    [
      'a persisted alias key is invalid',
      bindingsRun({ aliases: { planner: { provider: 'claude', model: 'opus' } } }, {}),
      /invalid model_bindings aliases/,
    ],
    [
      'a persisted provider is unavailable',
      bindingsRun({ tiers: { large: removedProvider } }, { large: removedProvider }),
      /Unknown provider: 'removed-provider'/,
    ],
    [
      'persisted metadata uses retired thinking config',
      bindingsRun({ tiers: { large: retiredThinking } }, { large: retiredThinking }),
      /thinking:.*effort:/,
    ],
  ])('terminalizes a resumed run before dispatch when %s', async (_label, run, error) => {
    const store = makeStore();
    await expect(startWorkflow({ store, workflow: large, options: resumeOf(run) })).rejects.toThrow(
      error
    );
    expect(store.failWorkflowRun).toHaveBeenCalledWith(run.id, expect.stringMatching(error));
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('fails a pre-created row when a semantic binding error stops startup', async () => {
    const store = makeStore();
    await expect(
      startWorkflow({
        store,
        workflow: large,
        options: {
          preCreatedRun: makeRun({ id: 'invalid-model-run', status: 'pending' }),
          modelOverrideLayer: {
            kind: 'raw',
            overrides: { aliases: { '@missing': 'gpt-5.6-sol' } },
          },
        },
      })
    ).rejects.toThrow(/'@missing' is not configured/);
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'invalid-model-run',
      expect.stringContaining("'@missing' is not configured")
    );
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('names the selected ref, not the whole preference list, in a provider-conflict warning', async () => {
    const platform = makePlatform();
    await startWorkflow({
      platform,
      workflow: makeWorkflow({ provider: 'claude', model: ['@cx', 'large'] }),
      options: {
        modelOverrideLayer: { kind: 'raw', overrides: { aliases: { '@cx': 'codex/gpt-5.6-sol' } } },
      },
    });
    const warning = sentMessages(platform).find(message => message.includes('sets provider'));
    expect(warning).toContain("model '@cx' resolves to provider 'codex'");
  });

  it('keeps concurrent profiles isolated and leaves no residue', async () => {
    const workflow = makeWorkflow({ model: 'large', mutates_checkout: false });
    const start = (id: string, options?: ExecuteWorkflowOptions) =>
      startWorkflow({
        store: makeStore({ createWorkflowRun: mock(async () => makeRun({ id })) }),
        conversationId: `conv-${id}`,
        workflow,
        message: id,
        origin: { conversationId: `db-${id}` },
        options,
      });
    await Promise.all([
      start('run-a', { modelOverrideLayer: overrideLarge('openai/gpt-5.6') }),
      start('run-b', { modelOverrideLayer: overrideLarge('codex/gpt-5.6-sol') }),
    ]);
    const concurrent = [0, 1].map(index => ({
      provider: dagCall(index)?.workflowProvider,
      model: dagCall(index)?.workflowModel,
    }));
    expect(concurrent).toContainEqual({ provider: 'pi', model: 'openai/gpt-5.6' });
    expect(concurrent).toContainEqual({ provider: 'codex', model: 'gpt-5.6-sol' });

    await start('run-c');
    expect(dagCall(2)?.workflowProvider).toBe('claude');
    expect(dagCall(2)?.workflowModel).not.toBe('openai/gpt-5.6');
    expect(dagCall(2)?.workflowModel).not.toBe('gpt-5.6-sol');
  });
});

describe('run-scoped config layer (#2482)', () => {
  const sealedMetadata: WorkflowRunConfigMetadata = {
    version: 1,
    ciphertext: 'opaque-ciphertext',
    source: { kind: 'cli', label: 'config.minimax.yaml' },
    keys: ['assistant', 'env.SHARED', 'tiers.large'],
  };
  const sealedRun = (id: string) => makeRun({ id, metadata: { run_config: sealedMetadata } });

  it('layers file content above DB/user config and explicit model mappings above the file', async () => {
    const createRun = mock<IWorkflowStore['createWorkflowRun']>(async data =>
      makeRun({ metadata: data.metadata })
    );
    const store = makeStore({
      createWorkflowRun: createRun,
      getCodebaseEnvVars: mock(async () => ({ SHARED: 'db', DB_ONLY: 'kept' })),
    });
    const sealRunConfig = mock(() => sealedMetadata);
    const deps: WorkflowDeps = {
      ...makeDeps(store),
      sealRunConfig,
      loadConfig: configWith({
        tiers: { large: { provider: 'claude', model: 'opus' } },
        envVars: { SHARED: 'repo', REPO_ONLY: 'kept' },
      }),
      getUserAiPrefs: mock(async () => ({
        defaultProvider: 'codex',
        tiers: { large: { provider: 'codex', model: 'gpt-5.5' } },
      })),
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderEnv: mock(async () => ({
        env: { PROTECTED_TOKEN: 'credential-wins' },
        files: [],
        protectedValues: ['credential-wins'],
      })),
    };

    await startWorkflow({
      deps,
      workflow: makeWorkflow({ model: 'large' }),
      origin: { conversationId: 'db-conv-1', userId: 'user-1' },
      options: {
        codebaseId: 'codebase-1',
        runConfig: {
          source: sealedMetadata.source,
          layer: {
            assistant: 'pi',
            tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
            envVars: { SHARED: 'run', PROTECTED_TOKEN: 'must-not-win' },
          },
        },
        modelOverrideLayer: overrideLarge('openai/gpt-5.6'),
      },
    });

    expect(sealRunConfig).toHaveBeenCalledTimes(1);
    expect(dagCall()?.workflowProvider).toBe('pi');
    expect(dagCall()?.workflowModel).toBe('openai/gpt-5.6');
    expect(dagCall()?.config).toMatchObject({
      assistant: 'pi',
      envVars: {
        REPO_ONLY: 'kept',
        DB_ONLY: 'kept',
        SHARED: 'run',
        PROTECTED_TOKEN: 'credential-wins',
      },
      protectedEnvKeys: ['PROTECTED_TOKEN'],
    });
    expect(createRun.mock.calls[0]?.[0].metadata).toMatchObject({
      run_config: sealedMetadata,
      model_bindings: {
        effective: {
          defaultProvider: 'pi',
          aliases: { large: { provider: 'pi', model: 'openai/gpt-5.6' } },
        },
      },
    });
  });

  it('persists sealed config on a pending pre-created run', async () => {
    const store = makeStore();
    const sealRunConfig = mock(() => sealedMetadata);
    const result = await startWorkflow({
      deps: { ...makeDeps(store), sealRunConfig },
      options: {
        preCreatedRun: makeRun({ id: 'pending-config-run', status: 'pending' }),
        runConfig: {
          source: sealedMetadata.source,
          layer: { docsPath: 'handbook' },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(sealRunConfig).toHaveBeenCalledTimes(1);
    expect(store.updateWorkflowRun).toHaveBeenCalledWith(
      'pending-config-run',
      expect.objectContaining({
        metadata: expect.objectContaining({ run_config: sealedMetadata }),
      })
    );
  });

  it('restores the sealed layer on cold resume without caller input', async () => {
    const unsealRunConfig = mock(() => ({
      docsPath: 'handbook',
      envVars: { RUN_ONLY: 'restored' },
    }));
    await startWorkflow({
      deps: { ...makeDeps(), unsealRunConfig },
      options: resumeOf(sealedRun('resume-config-run')),
    });
    expect(unsealRunConfig).toHaveBeenCalledWith(sealedMetadata);
    expect(dagCall()?.docsDir).toBe('handbook');
    expect(dagCall()?.config).toMatchObject({ envVars: { RUN_ONLY: 'restored' } });
  });

  it('terminalizes a pre-created run when persisted config cannot be restored', async () => {
    const store = makeStore();
    await expect(
      startWorkflow({
        deps: {
          ...makeDeps(store),
          unsealRunConfig: () => {
            throw new Error('Workflow run config could not be decrypted.');
          },
        },
        options: resumeOf(sealedRun('broken-config-run')),
      })
    ).rejects.toThrow('could not be decrypted');
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'broken-config-run',
      'Workflow run config could not be decrypted.'
    );
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('keeps concurrent run layers isolated and leaves no residue', async () => {
    const workflow = makeWorkflow({ model: 'large', mutates_checkout: false });
    const start = (id: string, options?: ExecuteWorkflowOptions) =>
      startWorkflow({
        deps: {
          ...makeDeps(makeStore({ createWorkflowRun: mock(async () => makeRun({ id })) })),
          sealRunConfig: () => sealedMetadata,
        },
        conversationId: `conv-${id}`,
        workflow,
        message: id,
        origin: { conversationId: `db-${id}` },
        options,
      });
    const layered = (provider: 'pi' | 'codex', model: string, marker: string) => ({
      runConfig: {
        source: sealedMetadata.source,
        layer: { tiers: { large: { provider, model } }, envVars: { RUN_MARKER: marker } },
      },
    });

    await Promise.all([
      start('config-a', layered('pi', 'openai/gpt-5.6', 'a')),
      start('config-b', layered('codex', 'gpt-5.6-sol', 'b')),
    ]);
    const concurrent = [0, 1].map(index => ({
      provider: dagCall(index)?.workflowProvider,
      model: dagCall(index)?.workflowModel,
      marker: dagCall(index)?.config.envVars?.RUN_MARKER,
    }));
    expect(concurrent).toContainEqual({ provider: 'pi', model: 'openai/gpt-5.6', marker: 'a' });
    expect(concurrent).toContainEqual({ provider: 'codex', model: 'gpt-5.6-sol', marker: 'b' });

    await start('config-clean');
    expect(dagCall(2)?.config.envVars?.RUN_MARKER).toBeUndefined();
    expect(dagCall(2)?.workflowProvider).toBe('claude');
  });
});
