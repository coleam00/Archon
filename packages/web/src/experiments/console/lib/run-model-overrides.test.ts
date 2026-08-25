import { describe, expect, test } from 'bun:test';
import { collectRunModelOverrides } from './run-model-overrides';

describe('collectRunModelOverrides', () => {
  test('empty rows mean as authored', () => {
    expect(collectRunModelOverrides([])).toEqual({ ok: true, overrides: {} });
  });

  test('separates sparse tier and alias mappings', () => {
    expect(
      collectRunModelOverrides([
        { id: 1, name: 'large', spec: 'openai/gpt-5.6' },
        { id: 2, name: '@planner', spec: 'codex/gpt-5.6-sol' },
      ])
    ).toEqual({
      ok: true,
      overrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });
  });

  test('rejects incomplete, invalid, and duplicate rows', () => {
    expect(collectRunModelOverrides([{ id: 1, name: 'large', spec: '' }])).toEqual({
      ok: false,
      error: 'Every model binding needs both a name and a model spec.',
    });
    expect(collectRunModelOverrides([{ id: 1, name: 'tiny', spec: 'x' }])).toMatchObject({
      ok: false,
    });
    expect(
      collectRunModelOverrides([
        { id: 1, name: 'large', spec: 'x' },
        { id: 2, name: 'large', spec: 'y' },
      ])
    ).toMatchObject({ ok: false });
  });
});
