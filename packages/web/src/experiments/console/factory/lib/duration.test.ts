import { expect, test } from 'bun:test';
import { durationWords } from './duration';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('every duration carries its units, at the grain a person reads it', () => {
  expect(durationWords(0)).toBe('0 s');
  expect(durationWords(45_900)).toBe('45 s');
  expect(durationWords(60_000)).toBe('1 min');
  expect(durationWords(40 * MIN + 59_000)).toBe('40 min');
  expect(durationWords(5 * HOUR)).toBe('5 h');
  expect(durationWords(3 * HOUR + 21 * MIN)).toBe('3 h 21 min');
  expect(durationWords(48 * HOUR)).toBe('2 d');
  expect(durationWords(52 * HOUR + 30 * MIN)).toBe('2 d 4 h');
});
