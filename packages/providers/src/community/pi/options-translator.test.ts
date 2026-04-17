import { describe, expect, test } from 'bun:test';

import type { NodeConfig } from '../../types';
import { resolvePiThinkingLevel, resolvePiTools } from './options-translator';

// ─── resolvePiThinkingLevel ─────────────────────────────────────────────

describe('resolvePiThinkingLevel', () => {
  test('returns undefined when no config provided', () => {
    expect(resolvePiThinkingLevel(undefined)).toEqual({ level: undefined });
  });

  test('returns undefined for empty config', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
  });

  test('maps valid thinking string directly', () => {
    expect(resolvePiThinkingLevel({ thinking: 'high' })).toEqual({ level: 'high' });
    expect(resolvePiThinkingLevel({ thinking: 'xhigh' })).toEqual({ level: 'xhigh' });
    expect(resolvePiThinkingLevel({ thinking: 'minimal' })).toEqual({ level: 'minimal' });
  });

  test('maps valid effort string directly', () => {
    expect(resolvePiThinkingLevel({ effort: 'medium' })).toEqual({ level: 'medium' });
    expect(resolvePiThinkingLevel({ effort: 'low' })).toEqual({ level: 'low' });
  });

  test('thinking takes precedence when both set', () => {
    expect(resolvePiThinkingLevel({ thinking: 'high', effort: 'low' })).toEqual({ level: 'high' });
  });

  test("'off' on either field returns undefined", () => {
    expect(resolvePiThinkingLevel({ thinking: 'off' })).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ effort: 'off' })).toEqual({ level: undefined });
  });

  test("'max' (Archon EffortLevel enum) translates to Pi 'xhigh'", () => {
    expect(resolvePiThinkingLevel({ effort: 'max' })).toEqual({ level: 'xhigh' });
    expect(resolvePiThinkingLevel({ thinking: 'max' })).toEqual({ level: 'xhigh' });
  });

  test('warns on Claude-shape object thinking config', () => {
    const result = resolvePiThinkingLevel({
      thinking: { type: 'enabled', budget_tokens: 4000 },
    } as NodeConfig);
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain('object form is Claude-specific');
  });

  test('warns on unknown string thinking value', () => {
    const result = resolvePiThinkingLevel({ thinking: 'ultra' });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain("unknown thinking level 'ultra'");
  });

  test('warns on unknown string effort value', () => {
    const result = resolvePiThinkingLevel({ effort: 'crushing' });
    expect(result.level).toBeUndefined();
    expect(result.warning).toContain("unknown thinking level 'crushing'");
  });

  test('no warning when both fields are simply absent', () => {
    expect(resolvePiThinkingLevel({})).toEqual({ level: undefined });
    expect(resolvePiThinkingLevel({ thinking: undefined, effort: undefined })).toEqual({
      level: undefined,
    });
  });
});

// ─── resolvePiTools ─────────────────────────────────────────────────────

describe('resolvePiTools', () => {
  const cwd = '/tmp/test-cwd';

  test('returns undefined tools when neither allowed_tools nor denied_tools set', () => {
    expect(resolvePiTools(cwd, undefined)).toEqual({ tools: undefined, unknownTools: [] });
    expect(resolvePiTools(cwd, {})).toEqual({ tools: undefined, unknownTools: [] });
  });

  test('allowed_tools: [] returns empty tools array (no-tools idiom)', () => {
    const result = resolvePiTools(cwd, { allowed_tools: [] });
    expect(result.tools).toEqual([]);
    expect(result.unknownTools).toEqual([]);
  });

  test('allowed_tools: [read, bash] returns exactly those two', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  test('case-insensitive tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['Read', 'BASH', 'Edit'] });
    expect(result.tools).toHaveLength(3);
    expect(result.unknownTools).toEqual([]);
  });

  test('unknown tool names (Claude-specific) collected in unknownTools', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'WebFetch', 'bash'] });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual(['WebFetch']);
  });

  test('denied_tools subtracts from allowed_tools', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'bash', 'edit'],
      denied_tools: ['bash'],
    });
    expect(result.tools).toHaveLength(2);
    expect(result.unknownTools).toEqual([]);
  });

  test('denied_tools alone starts from full built-in set', () => {
    const result = resolvePiTools(cwd, { denied_tools: ['bash', 'write'] });
    // Pi has 7 built-in tools, 2 denied → 5 remain
    expect(result.tools).toHaveLength(5);
    expect(result.unknownTools).toEqual([]);
  });

  test('dedupes duplicate tool names', () => {
    const result = resolvePiTools(cwd, { allowed_tools: ['read', 'read', 'Read'] });
    expect(result.tools).toHaveLength(1);
  });

  test('allowed and denied both with unknowns flags each', () => {
    const result = resolvePiTools(cwd, {
      allowed_tools: ['read', 'UnknownA'],
      denied_tools: ['UnknownB'],
    });
    expect(result.tools).toHaveLength(1); // only 'read'
    expect(result.unknownTools).toEqual(['UnknownA', 'UnknownB']);
  });
});
