import { describe, expect, test } from 'bun:test';
import { InvalidProviderRunConfigError } from '../../errors';
import { parseGrokConfig, parseGrokRunConfig, resolveGrokEffort } from './config';

describe('parseGrokConfig', () => {
  test('reads model and binary path', () => {
    expect(parseGrokConfig({ model: 'grok-4.6', grokBinaryPath: '/usr/bin/grok' })).toEqual({
      model: 'grok-4.6',
      grokBinaryPath: '/usr/bin/grok',
    });
  });

  test('omits blank and unknown types', () => {
    expect(parseGrokConfig({ model: '  ', grokBinaryPath: 1, extra: true })).toEqual({});
  });

  test('clamps modelReasoningEffort', () => {
    expect(parseGrokConfig({ modelReasoningEffort: 'ultra' })).toEqual({
      modelReasoningEffort: 'max',
    });
  });
});

describe('parseGrokRunConfig', () => {
  test('rejects unknown keys', () => {
    expect(() => parseGrokRunConfig({ yolo: true })).toThrow(InvalidProviderRunConfigError);
  });

  test('rejects blank model', () => {
    expect(() => parseGrokRunConfig({ model: '  ' })).toThrow(InvalidProviderRunConfigError);
  });
});

describe('resolveGrokEffort', () => {
  test('node effort wins', () => {
    expect(resolveGrokEffort('high', 'low')).toBe('high');
  });

  test('off disables', () => {
    expect(resolveGrokEffort('off', 'high')).toBeUndefined();
  });

  test('falls back to config', () => {
    expect(resolveGrokEffort(undefined, 'medium')).toBe('medium');
  });
});
