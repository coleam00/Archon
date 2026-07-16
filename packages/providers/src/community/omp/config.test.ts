import { describe, expect, test } from 'bun:test';
import { parseOmpConfig, type OmpProviderDefaults } from './config';

const validOmpConfigInput = {
  model: 'anthropic/claude-sonnet-4-5',
  agentDir: '/tmp/omp-agent',
  enableMCP: false,
  enableLsp: true,
  disableExtensionDiscovery: true,
  additionalExtensionPaths: ['/opt/omp/ext'],
  spawns: 'reviewer,planner',
  toolNames: ['read', 'search', 'bash'],
  interactive: false,
  extensionFlags: { plan: true, mode: 'strict' },
  env: { PLANNOTATOR_REMOTE: '1' },
  settings: {
    retry: { enabled: true, maxRetries: 3 },
    compaction: {
      enabled: false,
      strategy: 'snapcompact',
      supersedeReads: false,
      dropUseless: false,
      thresholdPercent: 80,
      thresholdTokens: 100000,
    },
    snapcompact: { systemPrompt: 'agents-md', toolResults: true, shape: 'auto' },
    contextPromotion: { enabled: true },
    model: { loopGuard: { enabled: false, checkAssistantContent: false } },
    tools: { approvalMode: 'write', maxTimeout: 30, xdev: false },
    edit: { enforceSeenLines: true },
    providers: {
      webSearch: 'gemini',
      webSearchExclude: ['brave', 'searxng'],
      image: 'openrouter',
    },
    task: {
      maxConcurrency: 8,
      maxRuntimeMs: 60000,
      prewalk: true,
      agentPrewalk: { reviewer: '@smol' },
    },
    generate_image: { enabled: false },
    astGrep: { enabled: false },
    memory: { backend: 'mnemopi' },
    mnemopi: {
      autoRecall: false,
      autoRetain: true,
      polyphonicRecall: true,
      enhancedRecall: true,
      noEmbeddings: false,
      debug: true,
    },
    hindsight: {
      autoRecall: true,
      autoRetain: false,
      debug: true,
      mentalModelsEnabled: false,
      mentalModelAutoSeed: false,
    },
    modelRoles: {
      default: 'anthropic/claude-sonnet-4-5',
      task: 'anthropic/claude-haiku-4-5',
    },
    enabledModels: ['anthropic/*', 'openrouter/qwen/*'],
    modelProviderOrder: ['anthropic', 'openrouter'],
    disabledProviders: ['experimental-provider'],
    disabledExtensions: ['risky-extension'],
  },
} satisfies Record<string, unknown>;

const validOmpConfigOutput = structuredClone(validOmpConfigInput) as OmpProviderDefaults;

describe('parseOmpConfig', () => {
  test('parses approved fields', () => {
    expect(parseOmpConfig(validOmpConfigInput)).toEqual(validOmpConfigOutput);
  });

  test('drops invalid values and makes invalid approval mode safe', () => {
    expect(
      parseOmpConfig({
        model: 42,
        agentDir: false,
        enableMCP: 'yes',
        enableLsp: 1,
        disableExtensionDiscovery: null,
        interactive: 'no',
        additionalExtensionPaths: ['/ok', 1, false],
        spawns: ['reviewer'],
        toolNames: ['read', null, 'bash'],
        extensionFlags: { plan: true, mode: 'strict', attempts: 3, empty: null },
        env: { KEEP: 'yes', DROP: 1 },
        settings: {
          retry: { enabled: 'yes', maxRetries: -1 },
          compaction: {
            enabled: 'no',
            strategy: 'invalid',
            supersedeReads: 'yes',
            dropUseless: 'no',
            thresholdPercent: 101,
            thresholdTokens: 0,
          },
          snapcompact: { systemPrompt: 'everything', toolResults: 'yes', shape: '' },
          model: { loopGuard: { enabled: 'yes', checkAssistantContent: 1 } },
          tools: { approvalMode: 'prompt', maxTimeout: -1, xdev: 'yes' },
          edit: { enforceSeenLines: 'yes' },
          providers: {
            webSearch: 'unknown',
            webSearchExclude: ['brave', 'unknown', 3],
            image: 'stable-diffusion',
          },
          task: {
            maxConcurrency: -1,
            maxRuntimeMs: 1.5,
            prewalk: 'yes',
            agentPrewalk: { reviewer: '@smol', invalid: false },
          },
          generate_image: { enabled: 'yes' },
          astGrep: { enabled: 1 },
          memory: { backend: 'remote' },
          mnemopi: {
            autoRecall: 'yes',
            autoRetain: true,
            polyphonicRecall: 1,
            enhancedRecall: false,
            noEmbeddings: 'no',
            debug: true,
          },
          hindsight: {
            autoRecall: null,
            autoRetain: false,
            debug: 'yes',
            mentalModelsEnabled: true,
            mentalModelAutoSeed: 0,
          },
          contextPromotion: null,
          modelRoles: { default: 'anthropic/claude-sonnet-4-5', bad: false },
          enabledModels: ['anthropic/*', 7],
          modelProviderOrder: [false, 'anthropic'],
          disabledProviders: ['experimental-provider', null],
          disabledExtensions: ['risky-extension', 1],
        },
        futureField: 'ignored',
      })
    ).toEqual({
      additionalExtensionPaths: ['/ok'],
      toolNames: ['read', 'bash'],
      extensionFlags: { plan: true, mode: 'strict' },
      env: { KEEP: 'yes' },
      settings: {
        providers: { webSearchExclude: ['brave'] },
        tools: { approvalMode: 'always-ask' },
        task: { agentPrewalk: { reviewer: '@smol' } },
        mnemopi: { autoRetain: true, enhancedRecall: false, debug: true },
        hindsight: { autoRetain: false, mentalModelsEnabled: true },
        modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
        enabledModels: ['anthropic/*'],
        modelProviderOrder: ['anthropic'],
        disabledProviders: ['experimental-provider'],
        disabledExtensions: ['risky-extension'],
      },
    });
  });

  test('keeps valid partial nested settings', () => {
    expect(
      parseOmpConfig({
        settings: {
          retry: { enabled: false, maxRetries: 0 },
          compaction: {
            enabled: true,
            strategy: 'context-full',
            supersedeReads: true,
            dropUseless: true,
            thresholdPercent: -1,
            thresholdTokens: 25000,
          },
          snapcompact: { systemPrompt: 'all', toolResults: false, shape: '8x8r-bw' },
          model: { loopGuard: { checkAssistantContent: false } },
          tools: { maxTimeout: 0, xdev: true },
          edit: { enforceSeenLines: false },
          providers: { webSearch: 'auto', image: 'auto' },
          task: {
            maxConcurrency: 0,
            maxRuntimeMs: 0,
            prewalk: false,
            agentPrewalk: { reviewer: '@smol' },
          },
          generate_image: { enabled: true },
          astGrep: { enabled: true },
          memory: { backend: 'off' },
        },
      })
    ).toEqual({
      settings: {
        retry: { enabled: false, maxRetries: 0 },
        compaction: {
          enabled: true,
          strategy: 'context-full',
          supersedeReads: true,
          dropUseless: true,
          thresholdPercent: -1,
          thresholdTokens: 25000,
        },
        snapcompact: { systemPrompt: 'all', toolResults: false, shape: '8x8r-bw' },
        model: { loopGuard: { checkAssistantContent: false } },
        tools: { maxTimeout: 0, xdev: true },
        edit: { enforceSeenLines: false },
        providers: { webSearch: 'auto', image: 'auto' },
        task: {
          maxConcurrency: 0,
          maxRuntimeMs: 0,
          prewalk: false,
          agentPrewalk: { reviewer: '@smol' },
        },
        generate_image: { enabled: true },
        astGrep: { enabled: true },
        memory: { backend: 'off' },
      },
    });
  });

  test('drops empty arrays, records, and unknown keys except explicit empty toolNames', () => {
    expect(
      parseOmpConfig({
        additionalExtensionPaths: [1],
        toolNames: [],
        extensionFlags: { attempts: 3 },
        env: { DROP: 1 },
        settings: {
          retry: { enabled: 'yes' },
          compaction: {},
          contextPromotion: { enabled: 'true' },
          modelRoles: { bad: false },
          enabledModels: [],
          modelProviderOrder: [false],
          disabledProviders: [],
          disabledExtensions: [1],
        },
        x: 'y',
      })
    ).toEqual({ toolNames: [] });
  });

  test('drops invalid non-string toolNames without clearing defaults', () => {
    expect(parseOmpConfig({ toolNames: [123, false, null] })).toEqual({});
  });
});
