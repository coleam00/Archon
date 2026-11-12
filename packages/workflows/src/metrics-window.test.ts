import { expect, test } from 'bun:test';
import { MetricsQueryError, resolveMetricsWindow } from './metrics';

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
