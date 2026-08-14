import { describe, expect, test } from 'bun:test';

import { parseClaudeConfig, parseClaudeSettingSources } from './config';

describe('parseClaudeSettingSources', () => {
  test('returns undefined for a non-array value', () => {
    expect(parseClaudeSettingSources(undefined)).toEqual({ invalid: [] });
    expect(parseClaudeSettingSources('project')).toEqual({ invalid: [] });
  });

  test('keeps recognized entries in order', () => {
    expect(parseClaudeSettingSources(['user', 'project'])).toEqual({
      value: ['user', 'project'],
      invalid: [],
    });
  });

  test('preserves an explicitly empty list', () => {
    expect(parseClaudeSettingSources([])).toEqual({ value: [], invalid: [] });
  });

  test('reports unrecognized entries instead of dropping them silently', () => {
    expect(parseClaudeSettingSources(['project', 'local'])).toEqual({
      value: ['project'],
      invalid: ['local'],
    });
  });

  test('serializes a non-string entry so the caller can name it', () => {
    expect(parseClaudeSettingSources([{ nope: 1 }])).toEqual({
      value: [],
      invalid: ['{"nope":1}'],
    });
  });
});

describe('parseClaudeConfig settingSources', () => {
  test('narrows to the recognized subset', () => {
    expect(parseClaudeConfig({ settingSources: ['project', 'user'] }).settingSources).toEqual([
      'project',
      'user',
    ]);
  });

  test('preserves an explicitly empty list rather than widening to defaults', () => {
    expect(parseClaudeConfig({ settingSources: [] }).settingSources).toEqual([]);
  });

  test('a wholly invalid list resolves to no sources, never the permissive default', () => {
    // Regression: the previous guard left settingSources unset here, so a single
    // typo fell through to the ['project','user'] default at provider level —
    // silently granting the ambient access the author was trying to exclude.
    expect(parseClaudeConfig({ settingSources: ['projct'] }).settingSources).toEqual([]);
  });

  test('drops only the invalid entry when some are valid', () => {
    expect(parseClaudeConfig({ settingSources: ['project', 'usr'] }).settingSources).toEqual([
      'project',
    ]);
  });

  test('leaves settingSources unset when the key is absent or not an array', () => {
    expect(parseClaudeConfig({}).settingSources).toBeUndefined();
    expect(parseClaudeConfig({ settingSources: 'project' }).settingSources).toBeUndefined();
  });
});
