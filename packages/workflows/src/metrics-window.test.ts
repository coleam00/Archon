import { expect, test } from 'bun:test';
import { MetricsQueryError, resolveMetricsSplit, resolveMetricsWindow } from './metrics';

const until = new Date('2026-10-30T12:00:00Z');

test.each([
  ['40m', '2026-10-30T11:20:00.000Z'],
  ['24h', '2026-10-29T12:00:00.000Z'],
  ['7d', '2026-10-23T12:00:00.000Z'],
  ['2w', '2026-10-16T12:00:00.000Z'],
  ['2026-10-29', '2026-10-29T00:00:00.000Z'],
  ['2026-10-30T12:00:00+01:00', '2026-10-30T11:00:00.000Z'],
])('resolves since %s', (since, expected) => {
  const window = resolveMetricsWindow({ since, until: until.toISOString() });
  expect(window.since.toISOString()).toBe(expected);
  expect(window.until).toEqual(until);
});

test.each(['40x', '0.5h', ''])('refuses since %j', since => {
  expect(() => resolveMetricsWindow({ since }, until)).toThrow(MetricsQueryError);
});

test.each(['since', 'until', 'compare'] as const)('escapes invalid %s values', field => {
  const value = '40x\nsecond line\r"third line"';
  try {
    if (field === 'compare') resolveMetricsSplit({ compare: value });
    else resolveMetricsWindow({ [field]: value }, until);
    throw new Error('Expected query refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(MetricsQueryError);
    if (!(error instanceof MetricsQueryError)) throw error;
    expect(error.message).toEndWith(`; got ${JSON.stringify(value)}`);
    expect(error.message).not.toMatch(/[\r\n]/);
  }
});
