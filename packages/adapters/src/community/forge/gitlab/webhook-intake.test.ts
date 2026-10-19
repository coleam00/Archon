import { describe, expect, test } from 'bun:test';
import { stripMention } from './webhook-intake';

describe('stripMention', () => {
  const strip = (text: string) => stripMention(text, 'archon');

  test('strips mention followed by space', () => {
    expect(strip('@archon hello')).toBe('hello');
  });

  test('strips mention followed by comma', () => {
    expect(strip('@archon, please help')).toBe('please help');
  });

  test('strips mention at end of string', () => {
    expect(strip('help me @archon')).toBe('help me');
  });

  test('does NOT strip partial-prefix username (@archonbot)', () => {
    // Regression: old regex `@archon[\s,:;]*` would strip '@archon' from '@archonbot',
    // yielding 'bot hello'. New regex requires a separator or end-of-string.
    expect(strip('@archonbot hello')).toBe('@archonbot hello');
  });
});
