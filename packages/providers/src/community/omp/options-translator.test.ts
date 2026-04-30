import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_OMP_TOOL_NAMES,
  getRuntimeAuthOverride,
  resolveOmpThinkingLevel,
  resolveOmpToolNames,
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
      resolveOmpToolNames({ allowed_tools: ['read', 'search', 'grep'], denied_tools: ['search'] })
    ).toEqual({ toolNames: ['read'], unknownTools: ['grep'] });
  });

  test('uses assistant toolNames as base', () => {
    expect(
      resolveOmpToolNames({ denied_tools: ['bash'] }, { toolNames: ['read', 'bash'] })
    ).toEqual({
      toolNames: ['read'],
      unknownTools: [],
    });
  });
});

describe('getRuntimeAuthOverride', () => {
  test('reads provider-specific env override', () => {
    expect(getRuntimeAuthOverride('anthropic', { ANTHROPIC_API_KEY: 'sk-test' })).toBe('sk-test');
  });

  test('returns undefined for unmapped provider', () => {
    expect(getRuntimeAuthOverride('local', { LOCAL_API_KEY: 'x' })).toBeUndefined();
  });
});
