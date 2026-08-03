import { describe, test, expect } from 'bun:test';
import { normalizeOAuthCode } from './oauth-code';

describe('normalizeOAuthCode', () => {
  test('full localhost callback URL → code#state', () => {
    expect(normalizeOAuthCode('http://localhost:53692/callback?code=ABC&state=XYZ')).toBe(
      'ABC#XYZ'
    );
  });

  test('bare code=…&state=… query → code#state', () => {
    expect(normalizeOAuthCode('code=ABC&state=XYZ')).toBe('ABC#XYZ');
  });

  test('URL with code but no state → bare code', () => {
    expect(normalizeOAuthCode('http://localhost/cb?code=ABC')).toBe('ABC');
  });

  test('already code#state → unchanged', () => {
    expect(normalizeOAuthCode('ABC#XYZ')).toBe('ABC#XYZ');
  });

  test('bare code (no code= marker) → unchanged', () => {
    expect(normalizeOAuthCode('ABC')).toBe('ABC');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeOAuthCode('  ABC  ')).toBe('ABC');
    expect(normalizeOAuthCode('  http://x/cb?code=A&state=B ')).toBe('A#B');
  });
});
