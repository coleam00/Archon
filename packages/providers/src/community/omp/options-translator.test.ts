import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  applyConfigEnv,
  buildOmpSettingsOverrides,
  DEFAULT_OMP_TOOL_NAMES,
  getRuntimeAuthOverride,
  resolveOmpThinkingLevel,
  resolveOmpToolNames,
  restoreConfigEnv,
} from './options-translator';

describe('resolveOmpThinkingLevel', () => {
  test('maps effort max to xhigh and thinking wins', () => {
    expect(resolveOmpThinkingLevel({ effort: 'max' }).level).toBe('xhigh');
    expect(resolveOmpThinkingLevel({ effort: 'low', thinking: 'high' }).level).toBe('high');
  });

  test('warns on unsupported object thinking', () => {
    const result = resolveOmpThinkingLevel({ thinking: { type: 'enabled' } });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain('Claude-specific');
  });
});

describe('resolveOmpToolNames', () => {
  test('uses curated defaults', () => {
    expect(resolveOmpToolNames().toolNames).toEqual([...DEFAULT_OMP_TOOL_NAMES]);
  });

  test('honors allowed and denied tools in OMP namespace', () => {
    expect(
      resolveOmpToolNames({ allowed_tools: ['read', 'ssh', 'grep'], denied_tools: ['search'] })
    ).toEqual({ toolNames: ['read', 'ssh'], unknownTools: ['grep'] });
  });

  test('uses assistant toolNames as base', () => {
    expect(
      resolveOmpToolNames({ denied_tools: ['bash'] }, { toolNames: ['read', 'bash'] })
    ).toEqual({
      toolNames: ['read'],
      unknownTools: [],
    });
  });

  test('respects explicit empty assistant toolNames list', () => {
    expect(resolveOmpToolNames(undefined, { toolNames: [] })).toEqual({
      toolNames: [],
      unknownTools: [],
    });
  });
});

describe('buildOmpSettingsOverrides', () => {
  test('maps verified OMP settings keys', () => {
    expect(
      buildOmpSettingsOverrides({
        settings: {
          retry: { enabled: true, maxRetries: 3 },
          compaction: { enabled: false },
          contextPromotion: { enabled: true },
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
      'contextPromotion.enabled': true,
      modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
      enabledModels: ['anthropic/*'],
      modelProviderOrder: ['anthropic'],
      disabledProviders: ['experimental-provider'],
      disabledExtensions: ['risky-extension'],
    });
  });

  test('returns an empty object without settings', () => {
    expect(buildOmpSettingsOverrides({})).toEqual({});
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
});

describe('getRuntimeAuthOverride', () => {
  const originalHuggingFaceHubToken = process.env.HUGGINGFACE_HUB_TOKEN;
  const originalHfToken = process.env.HF_TOKEN;

  beforeEach(() => {
    delete process.env.HUGGINGFACE_HUB_TOKEN;
    delete process.env.HF_TOKEN;
  });

  afterEach(() => {
    if (originalHuggingFaceHubToken === undefined) delete process.env.HUGGINGFACE_HUB_TOKEN;
    else process.env.HUGGINGFACE_HUB_TOKEN = originalHuggingFaceHubToken;

    if (originalHfToken === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = originalHfToken;
  });

  test('reads provider-specific env override', () => {
    expect(getRuntimeAuthOverride('anthropic', { ANTHROPIC_API_KEY: 'sk-test' })).toBe('sk-test');
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
