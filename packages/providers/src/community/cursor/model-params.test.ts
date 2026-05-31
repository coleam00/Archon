import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PARAMS,
  resolveModelId,
  resolveModelParams,
  toModelSelection,
} from './model-params';

describe('resolveModelParams', () => {
  test('applies default thinking low when no config or node', () => {
    expect(resolveModelParams(undefined, {})).toEqual({
      params: { ...DEFAULT_MODEL_PARAMS },
    });
  });

  test('merges config modelParams over defaults', () => {
    expect(resolveModelParams(undefined, { modelParams: { thinking: 'high' } })).toEqual({
      params: { thinking: 'high' },
    });
  });

  test('node effort maps to thinking', () => {
    expect(resolveModelParams({ effort: 'max' }, {})).toEqual({
      params: { thinking: 'high' },
    });
  });

  test('node thinking wins over effort', () => {
    expect(resolveModelParams({ thinking: 'medium', effort: 'low' }, {})).toEqual({
      params: { thinking: 'medium' },
    });
  });

  test('off clears thinking', () => {
    expect(resolveModelParams({ effort: 'off' }, { modelParams: { thinking: 'high' } })).toEqual({
      params: {},
    });
  });

  test('warns on Claude object thinking', () => {
    const result = resolveModelParams({ thinking: { type: 'enabled' } }, {});
    expect(result.warning).toContain('object form is Claude-specific');
    expect(result.params.thinking).toBe('low');
  });

  test('warns on unknown effort string', () => {
    const result = resolveModelParams({ effort: 'turbo' }, {});
    expect(result.warning).toContain('turbo');
  });
});

describe('toModelSelection', () => {
  test('builds auto with thinking param', () => {
    expect(toModelSelection('auto', { thinking: 'low' })).toEqual({
      id: 'auto',
      params: [{ id: 'thinking', value: 'low' }],
    });
  });

  test('omits params when empty', () => {
    expect(toModelSelection('auto', {})).toEqual({ id: 'auto' });
  });
});

describe('resolveModelId', () => {
  test('defaults to auto', () => {
    expect(resolveModelId(undefined, {})).toBe(DEFAULT_MODEL_ID);
  });

  test('request model overrides config', () => {
    expect(resolveModelId('composer-2.0', { model: 'auto' })).toBe('composer-2.0');
  });

  test('trims whitespace', () => {
    expect(resolveModelId('  auto  ', {})).toBe('auto');
  });
});
