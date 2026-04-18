import { describe, it, expect } from 'bun:test';
import {
  parseAllowlist,
  isLoopbackOrigin,
  matchOrigin,
  MUTATING_METHODS,
  type OriginAllowlist,
} from './origin';

describe('parseAllowlist', () => {
  it('defaults to loopback when nothing configured', () => {
    expect(parseAllowlist(undefined, undefined)).toEqual({ mode: 'loopback' });
    expect(parseAllowlist('', '')).toEqual({ mode: 'loopback' });
    expect(parseAllowlist('   ', undefined)).toEqual({ mode: 'loopback' });
  });

  it('recognises "*" as any-origin', () => {
    expect(parseAllowlist('*', undefined)).toEqual({ mode: 'any' });
    expect(parseAllowlist(undefined, '*')).toEqual({ mode: 'any' });
  });

  it('parses a comma-separated list', () => {
    const result = parseAllowlist('https://a.example, https://b.example', undefined);
    expect(result.mode).toBe('list');
    if (result.mode !== 'list') throw new Error('mode mismatch');
    expect(result.origins.has('https://a.example')).toBe(true);
    expect(result.origins.has('https://b.example')).toBe(true);
  });

  it('trims whitespace and drops empty segments', () => {
    const result = parseAllowlist(' https://a.example , , https://b.example ', undefined);
    if (result.mode !== 'list') throw new Error('mode mismatch');
    expect(result.origins.size).toBe(2);
  });

  it('prefers ALLOWED_ORIGINS over legacy WEB_UI_ORIGIN', () => {
    const result = parseAllowlist('https://new.example', 'https://legacy.example');
    if (result.mode !== 'list') throw new Error('mode mismatch');
    expect(result.origins.has('https://new.example')).toBe(true);
    expect(result.origins.has('https://legacy.example')).toBe(false);
  });

  it('falls back to WEB_UI_ORIGIN when ALLOWED_ORIGINS is empty', () => {
    const result = parseAllowlist(undefined, 'https://legacy.example');
    if (result.mode !== 'list') throw new Error('mode mismatch');
    expect(result.origins.has('https://legacy.example')).toBe(true);
  });
});

describe('isLoopbackOrigin', () => {
  it('accepts localhost on any port', () => {
    expect(isLoopbackOrigin('http://localhost')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:3090')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('https://localhost:8443')).toBe(true);
  });

  it('accepts 127.0.0.1 on any port', () => {
    expect(isLoopbackOrigin('http://127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3090')).toBe(true);
  });

  it('accepts IPv6 loopback', () => {
    expect(isLoopbackOrigin('http://[::1]')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3090')).toBe(true);
  });

  it('rejects non-loopback origins', () => {
    expect(isLoopbackOrigin('http://example.com')).toBe(false);
    expect(isLoopbackOrigin('http://192.168.1.100:3090')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.evil.com')).toBe(false);
    expect(isLoopbackOrigin('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('rejects non-URL strings', () => {
    expect(isLoopbackOrigin('localhost')).toBe(false);
    expect(isLoopbackOrigin('')).toBe(false);
    expect(isLoopbackOrigin('not-a-url')).toBe(false);
  });
});

describe('matchOrigin', () => {
  it('allows missing Origin header (same-origin / non-browser clients)', () => {
    expect(matchOrigin(undefined, { mode: 'loopback' })).toBe(true);
    expect(matchOrigin('', { mode: 'loopback' })).toBe(true);
    expect(matchOrigin(undefined, { mode: 'any' })).toBe(true);
  });

  it('mode=any accepts everything', () => {
    const allow: OriginAllowlist = { mode: 'any' };
    expect(matchOrigin('http://example.com', allow)).toBe(true);
    expect(matchOrigin('http://localhost:3090', allow)).toBe(true);
  });

  it('mode=loopback accepts only loopback origins', () => {
    const allow: OriginAllowlist = { mode: 'loopback' };
    expect(matchOrigin('http://localhost:5173', allow)).toBe(true);
    expect(matchOrigin('http://127.0.0.1:3090', allow)).toBe(true);
    expect(matchOrigin('http://[::1]:3090', allow)).toBe(true);
    expect(matchOrigin('http://192.168.1.1:3090', allow)).toBe(false);
    expect(matchOrigin('http://example.com', allow)).toBe(false);
  });

  it('mode=list accepts only exact matches', () => {
    const allow: OriginAllowlist = {
      mode: 'list',
      origins: new Set(['https://app.example.com']),
    };
    expect(matchOrigin('https://app.example.com', allow)).toBe(true);
    expect(matchOrigin('https://app.example.com:443', allow)).toBe(false); // port differs
    expect(matchOrigin('http://app.example.com', allow)).toBe(false); // scheme differs
    expect(matchOrigin('https://evil.example.com', allow)).toBe(false);
  });
});

describe('MUTATING_METHODS', () => {
  it('includes POST, PUT, PATCH, DELETE', () => {
    expect(MUTATING_METHODS.has('POST')).toBe(true);
    expect(MUTATING_METHODS.has('PUT')).toBe(true);
    expect(MUTATING_METHODS.has('PATCH')).toBe(true);
    expect(MUTATING_METHODS.has('DELETE')).toBe(true);
  });

  it('excludes safe methods', () => {
    expect(MUTATING_METHODS.has('GET')).toBe(false);
    expect(MUTATING_METHODS.has('HEAD')).toBe(false);
    expect(MUTATING_METHODS.has('OPTIONS')).toBe(false);
  });
});
