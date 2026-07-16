import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  applyConfigEnv,
  buildOmpSettingsOverrides,
  DEFAULT_OMP_TOOL_NAMES,
  getRuntimeAuthOverride,
  resolveOmpThinkingLevel,
  resolveOmpToolNames,
  selectAppliedConfigEnv,
  restoreConfigEnv,
} from './options-translator';

describe('resolveOmpThinkingLevel', () => {
  test('passes through OMP max thinking selector', () => {
    expect(resolveOmpThinkingLevel({ effort: 'max' }).level).toBe('max');
    expect(resolveOmpThinkingLevel({ effort: 'low', thinking: 'max' }).level).toBe('max');
  });

  test('passes through OMP auto thinking selector', () => {
    expect(resolveOmpThinkingLevel({ effort: 'auto' }).level).toBe('auto');
    expect(resolveOmpThinkingLevel({ effort: 'low', thinking: 'auto' }).level).toBe('auto');
  });

  test('passes through OMP off thinking selector', () => {
    expect(resolveOmpThinkingLevel({ effort: 'off' }).level).toBe('off');
    expect(resolveOmpThinkingLevel({ effort: 'high', thinking: 'off' }).level).toBe('off');
  });

  test('warns on unsupported object thinking', () => {
    const result = resolveOmpThinkingLevel({ thinking: { type: 'enabled' } });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain('Claude-specific');
  });
});

describe('resolveOmpToolNames', () => {
  test('uses the curated OMP v17 default tools', () => {
    expect(DEFAULT_OMP_TOOL_NAMES).toEqual([
      'ask',
      'bash',
      'eval',
      'edit',
      'glob',
      'grep',
      'ast_grep',
      'ast_edit',
      'lsp',
      'read',
      'browser',
      'task',
      'hub',
      'todo',
      'web_search',
      'write',
      'inspect_image',
    ]);
    expect(resolveOmpToolNames()).toEqual({
      toolNames: [...DEFAULT_OMP_TOOL_NAMES],
      unknownTools: [],
      unknownDeniedTools: [],
    });
  });

  test('accepts the exact known conditional OMP v17 tools', () => {
    const toolNames = [
      'debug',
      'github',
      'checkpoint',
      'rewind',
      'yield',
      'goal',
      'generate_image',
      'memory_edit',
      'retain',
      'recall',
      'reflect',
      'learn',
      'manage_skill',
    ];

    expect(resolveOmpToolNames({ allowed_tools: toolNames })).toEqual({
      toolNames,
      unknownTools: [],
      unknownDeniedTools: [],
    });
  });

  test('reports direct names removed from OMP v17 as unknown', () => {
    const removedNames = [
      'job',
      'launch',
      'ssh',
      'irc',
      'resolve',
      'render_mermaid',
      'search_tool_bm25',
      'report_finding',
      'report_tool_issue',
    ];

    expect(resolveOmpToolNames({ allowed_tools: ['read', ...removedNames] })).toEqual({
      toolNames: ['read'],
      unknownTools: removedNames,
      unknownDeniedTools: [],
    });
  });

  test('maps retained OMP tool aliases to v17 names', () => {
    expect(
      resolveOmpToolNames({
        allowed_tools: ['python', 'search', 'find', 'fetch', 'poll', 'todo_write'],
      })
    ).toEqual({
      toolNames: ['eval', 'grep', 'glob', 'read', 'hub', 'todo'],
      unknownTools: [],
      unknownDeniedTools: [],
    });
  });

  test('honors allowed and denied tools in OMP namespace', () => {
    expect(
      resolveOmpToolNames({ allowed_tools: ['read', 'hub', 'search'], denied_tools: ['grep'] })
    ).toEqual({ toolNames: ['read', 'hub'], unknownTools: [], unknownDeniedTools: [] });
  });

  test('reports unknown denied tools separately', () => {
    expect(resolveOmpToolNames({ denied_tools: ['bash', 'typo_tool'] })).toEqual({
      toolNames: DEFAULT_OMP_TOOL_NAMES.filter(name => name !== 'bash'),
      unknownTools: [],
      unknownDeniedTools: ['typo_tool'],
    });
  });

  test('uses assistant toolNames as base', () => {
    expect(
      resolveOmpToolNames({ denied_tools: ['bash'] }, { toolNames: ['read', 'bash'] })
    ).toEqual({
      toolNames: ['read'],
      unknownTools: [],
      unknownDeniedTools: [],
    });
  });

  test('respects explicit empty assistant toolNames list', () => {
    expect(resolveOmpToolNames(undefined, { toolNames: [] })).toEqual({
      toolNames: [],
      unknownTools: [],
      unknownDeniedTools: [],
    });
  });
});

describe('buildOmpSettingsOverrides', () => {
  test('maps verified OMP settings keys', () => {
    expect(
      buildOmpSettingsOverrides({
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
          tools: { approvalMode: 'always-ask', maxTimeout: 30, xdev: false },
          edit: { enforceSeenLines: true },
          providers: {
            webSearch: 'tavily',
            webSearchExclude: ['brave'],
            image: 'gemini',
          },
          task: {
            maxConcurrency: 4,
            maxRuntimeMs: 60000,
            prewalk: true,
            agentPrewalk: { reviewer: '@smol' },
          },
          generate_image: { enabled: false },
          astGrep: { enabled: false },
          memory: { backend: 'hindsight' },
          mnemopi: {
            autoRecall: false,
            autoRetain: true,
            polyphonicRecall: true,
            enhancedRecall: false,
            noEmbeddings: true,
            debug: true,
          },
          hindsight: {
            autoRecall: true,
            autoRetain: false,
            debug: true,
            mentalModelsEnabled: false,
            mentalModelAutoSeed: false,
          },
          modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
          enabledModels: ['anthropic/*'],
          modelProviderOrder: ['anthropic'],
          disabledProviders: ['experimental-provider'],
          disabledExtensions: ['risky-extension'],
        },
      })
    ).toEqual({
      'retry.enabled': true,
      'retry.maxRetries': 3,
      'compaction.enabled': false,
      'compaction.strategy': 'snapcompact',
      'compaction.supersedeReads': false,
      'compaction.dropUseless': false,
      'compaction.thresholdPercent': 80,
      'compaction.thresholdTokens': 100000,
      'snapcompact.systemPrompt': 'agents-md',
      'snapcompact.toolResults': true,
      'snapcompact.shape': 'auto',
      'contextPromotion.enabled': true,
      'model.loopGuard.enabled': false,
      'model.loopGuard.checkAssistantContent': false,
      'tools.approvalMode': 'always-ask',
      'tools.maxTimeout': 30,
      'tools.xdev': false,
      'edit.enforceSeenLines': true,
      'providers.webSearch': 'tavily',
      'providers.webSearchExclude': ['brave'],
      'providers.image': 'gemini',
      'task.maxConcurrency': 4,
      'task.maxRuntimeMs': 60000,
      'task.prewalk': true,
      'task.agentPrewalk': { reviewer: '@smol' },
      'generate_image.enabled': false,
      'astGrep.enabled': false,
      'memory.backend': 'hindsight',
      'mnemopi.autoRecall': false,
      'mnemopi.autoRetain': true,
      'mnemopi.polyphonicRecall': true,
      'mnemopi.enhancedRecall': false,
      'mnemopi.noEmbeddings': true,
      'mnemopi.debug': true,
      'hindsight.autoRecall': true,
      'hindsight.autoRetain': false,
      'hindsight.debug': true,
      'hindsight.mentalModelsEnabled': false,
      'hindsight.mentalModelAutoSeed': false,
      modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
      enabledModels: ['anthropic/*'],
      modelProviderOrder: ['anthropic'],
      disabledProviders: ['experimental-provider'],
      disabledExtensions: ['risky-extension'],
    });
  });

  test('preserves Archon AST-grep default without settings', () => {
    expect(buildOmpSettingsOverrides({})).toEqual({ 'astGrep.enabled': true });
  });

  test('honors explicit AST-grep opt-out', () => {
    expect(buildOmpSettingsOverrides({ settings: { astGrep: { enabled: false } } })).toEqual({
      'astGrep.enabled': false,
    });
  });
});

describe('applyConfigEnv', () => {
  test('applies only missing env vars and returns applied keys', () => {
    const targetEnv: Record<string, string | undefined> = { EXISTING: 'shell' };

    expect(applyConfigEnv({ EXISTING: 'config', NEW_KEY: 'value' }, targetEnv)).toEqual([
      'NEW_KEY',
    ]);
    expect(targetEnv).toEqual({ EXISTING: 'shell', NEW_KEY: 'value' });
  });

  test('returns empty list without env', () => {
    const targetEnv: Record<string, string | undefined> = {};
    expect(applyConfigEnv(undefined, targetEnv)).toEqual([]);
    expect(targetEnv).toEqual({});
  });

  test('restores env keys even when session code changed their values', () => {
    const targetEnv: Record<string, string | undefined> = {};
    const applied = applyConfigEnv({ A: 'config-a', B: 'config-b' }, targetEnv);
    targetEnv.B = 'changed';

    restoreConfigEnv(applied, targetEnv);

    expect(targetEnv).toEqual({});
  });

  test('selects only config env keys that were applied to process env', () => {
    expect(
      selectAppliedConfigEnv({ ANTHROPIC_API_KEY: 'config', OTHER: 'value' }, ['OTHER'])
    ).toEqual({ OTHER: 'value' });
    expect(selectAppliedConfigEnv({ ANTHROPIC_API_KEY: 'config' }, [])).toBeUndefined();
  });
});

describe('getRuntimeAuthOverride', () => {
  const originalHuggingFaceHubToken = process.env.HUGGINGFACE_HUB_TOKEN;
  const originalHfToken = process.env.HF_TOKEN;
  const originalAnthropicFoundryApiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
  const originalClaudeCodeUseFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY;

  beforeEach(() => {
    delete process.env.HUGGINGFACE_HUB_TOKEN;
    delete process.env.HF_TOKEN;
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  });

  afterEach(() => {
    if (originalHuggingFaceHubToken === undefined) delete process.env.HUGGINGFACE_HUB_TOKEN;
    else process.env.HUGGINGFACE_HUB_TOKEN = originalHuggingFaceHubToken;

    if (originalHfToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = originalHfToken;

    if (originalAnthropicFoundryApiKey === undefined) delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    else process.env.ANTHROPIC_FOUNDRY_API_KEY = originalAnthropicFoundryApiKey;

    if (originalClaudeCodeUseFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    else process.env.CLAUDE_CODE_USE_FOUNDRY = originalClaudeCodeUseFoundry;
  });

  test('reads provider-specific env override', () => {
    expect(getRuntimeAuthOverride('anthropic', { ANTHROPIC_API_KEY: 'sk-test' })).toBe('sk-test');
  });

  test('honors request-scoped Foundry flag for Anthropic runtime auth', () => {
    expect(
      getRuntimeAuthOverride('anthropic', {
        ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
        ANTHROPIC_API_KEY: 'api-key',
      })
    ).toBe('api-key');

    expect(
      getRuntimeAuthOverride('anthropic', {
        CLAUDE_CODE_USE_FOUNDRY: 'yes',
        ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key',
        ANTHROPIC_API_KEY: 'api-key',
      })
    ).toBe('foundry-key');
  });

  test('uses process Foundry flag for Anthropic runtime auth', () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = 'true';
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'process-foundry';

    expect(getRuntimeAuthOverride('anthropic', undefined)).toBe('process-foundry');
    expect(
      getRuntimeAuthOverride('anthropic', {
        ANTHROPIC_FOUNDRY_API_KEY: 'request-foundry',
        ANTHROPIC_API_KEY: 'api-key',
      })
    ).toBe('request-foundry');
  });

  test('reads request-scoped API keys for newer OMP providers', () => {
    expect(getRuntimeAuthOverride('moonshot', { MOONSHOT_API_KEY: 'moonshot-key' })).toBe(
      'moonshot-key'
    );
    expect(getRuntimeAuthOverride('qwen-portal', { QWEN_PORTAL_API_KEY: 'qwen-key' })).toBe(
      'qwen-key'
    );
    expect(getRuntimeAuthOverride('xai-oauth', { XAI_OAUTH_TOKEN: 'xai-oauth-token' })).toBe(
      'xai-oauth-token'
    );
    expect(getRuntimeAuthOverride('wafer-pass', { WAFER_PASS_API_KEY: 'wafer-key' })).toBe(
      'wafer-key'
    );
    expect(getRuntimeAuthOverride('zhipu-coding-plan', { ZHIPU_API_KEY: 'zhipu-key' })).toBe(
      'zhipu-key'
    );
    expect(getRuntimeAuthOverride('aimlapi', { AIMLAPI_API_KEY: 'aiml-key' })).toBe('aiml-key');
    expect(getRuntimeAuthOverride('azure', { AZURE_OPENAI_API_KEY: 'azure-key' })).toBe(
      'azure-key'
    );
    expect(
      getRuntimeAuthOverride('xiaomi-token-plan-ams', {
        XIAOMI_TOKEN_PLAN_AMS_API_KEY: 'xiaomi-ams-key',
      })
    ).toBe('xiaomi-ams-key');
  });

  test('reads Umans request-scoped API key', () => {
    expect(getRuntimeAuthOverride('umans', { UMANS_AI_CODING_PLAN_API_KEY: 'umans-key' })).toBe(
      'umans-key'
    );
  });

  test('prefers Anthropic OAuth token over API key', () => {
    expect(
      getRuntimeAuthOverride('anthropic', {
        ANTHROPIC_OAUTH_TOKEN: 'oauth-token',
        ANTHROPIC_API_KEY: 'api-key',
      })
    ).toBe('oauth-token');
  });

  test('falls back to Claude Code OAuth token for Anthropic', () => {
    expect(
      getRuntimeAuthOverride('anthropic', {
        CLAUDE_CODE_OAUTH_TOKEN: 'claude-code-oauth-token',
        ANTHROPIC_API_KEY: 'api-key',
      })
    ).toBe('claude-code-oauth-token');
  });
  test('reads Hugging Face hub token before generic HF token', () => {
    expect(
      getRuntimeAuthOverride('huggingface', {
        HF_TOKEN: 'hf-fallback',
        HUGGINGFACE_HUB_TOKEN: 'hf-primary',
      })
    ).toBe('hf-primary');
  });

  test('falls back to HF_TOKEN for Hugging Face', () => {
    expect(getRuntimeAuthOverride('huggingface', { HF_TOKEN: 'hf-fallback' })).toBe('hf-fallback');
  });

  test('request Hugging Face env overrides process env across supported names', () => {
    process.env.HUGGINGFACE_HUB_TOKEN = 'process-primary';

    expect(getRuntimeAuthOverride('huggingface', { HF_TOKEN: 'request-fallback' })).toBe(
      'request-fallback'
    );
  });

  test('falls back to process env when request env has no supported Hugging Face token', () => {
    process.env.HF_TOKEN = 'process-fallback';

    expect(getRuntimeAuthOverride('huggingface', undefined)).toBe('process-fallback');
  });

  test('does not use unsupported Hugging Face API key env name', () => {
    expect(
      getRuntimeAuthOverride('huggingface', { HUGGINGFACE_API_KEY: 'hf-legacy' })
    ).toBeUndefined();
  });

  test('returns undefined for unmapped provider', () => {
    expect(getRuntimeAuthOverride('local', { LOCAL_API_KEY: 'x' })).toBeUndefined();
  });
});
