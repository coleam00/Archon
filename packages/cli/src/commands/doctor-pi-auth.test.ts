/**
 * Credential-validity half of the Pi provider check (#3274).
 *
 * `probeAuthJsonExists` answers "is the file on disk", which is what `checkPi`
 * used to report as `pass`. A Pi OAuth grant that expired months ago also has
 * its file on disk, so an install whose every Pi workflow fails still got a
 * green doctor. The file's presence is necessary, not sufficient.
 *
 * These tests pin the parsing half only: read the store Archon already reads
 * (`~/.pi/agent/auth.json`) and report what the credential in it says. No
 * network probe, no scanning of other tools' stores.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPiAuthValidity } from './doctor-pi-auth';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archon-pi-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true });
});

/** One OAuth credential, in the shape `pi /login` writes. */
function oauthEntry(expires: number): unknown {
  return {
    type: 'oauth',
    access: 'stored-access-token',
    refresh: 'stored-refresh-token',
    expires,
  };
}

describe('readPiAuthValidity', () => {
  test('an OAuth grant that expired in the past is reported expired, naming the date', () => {
    // 8 June 2026 — the expiry from the install that motivated #3274.
    const expiredAt = Date.UTC(2026, 5, 8);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: oauthEntry(expiredAt) }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('expired');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.expiresAt).toBe(expiredAt);
    expect(result.providers).toEqual(['anthropic']);
  });

  test('an OAuth grant that is still valid is reported valid', () => {
    const expiresAt = Date.UTC(2027, 0, 1);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: oauthEntry(expiresAt) }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.expiresAt).toBe(expiresAt);
  });

  test('a grant expiring exactly now counts as expired (the mint path uses >=)', () => {
    const expiresAt = Date.UTC(2026, 8, 10, 12, 0, 0);
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: oauthEntry(expiresAt) }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: expiresAt });

    expect(result.status).toBe('expired');
  });

  test('an API-key entry is never treated as expiring', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ openrouter: { type: 'api-key', key: 'sk-stored' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.providers).toEqual(['openrouter']);
  });

  test('the soonest expiry across providers decides the verdict', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: oauthEntry(Date.UTC(2027, 0, 1)),
        'github-copilot': oauthEntry(Date.UTC(2026, 5, 8)),
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('expired');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.expiresAt).toBe(Date.UTC(2026, 5, 8));
  });

  test('a missing file is reported missing, not expired', () => {
    const result = readPiAuthValidity(join(dir, 'does-not-exist.json'), {
      now: Date.UTC(2026, 8, 10),
    });

    expect(result.status).toBe('missing');
  });

  test('malformed JSON is reported unreadable rather than crashing the doctor run', () => {
    writeFileSync(join(dir, 'auth.json'), '{ not json');

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an empty object reports missing credentials without claiming validity', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({}));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('empty');
  });

  test('a credential value is never carried into the result', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: oauthEntry(Date.UTC(2026, 5, 8)) })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('stored-access-token');
    expect(serialized).not.toContain('stored-refresh-token');
  });
});
