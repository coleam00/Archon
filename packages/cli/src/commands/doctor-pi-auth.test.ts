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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

  test('a store that cannot be read is unreadable, not missing', () => {
    // auth.json is a directory: readFileSync throws EISDIR. Reporting that as
    // `missing` sends the operator looking for a `pi /login` that cannot fix
    // a path that exists but is the wrong kind of thing.
    mkdirSync(join(dir, 'auth.json'));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an absent file is still missing', () => {
    // The other half of the errno split: ENOENT is the only `missing`.
    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('missing');
  });

  test('an OAuth grant with no usable expiry is unreadable, not valid', () => {
    // The entry declares `type: 'oauth'` but carries no `expires`. Filtering it
    // out leaves no expiries at all, which the old code read as "an API-key-only
    // store" and reported valid — a store no Pi workflow can authenticate
    // against, wearing a green doctor.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'oauth', access: 'stored-access-token' },
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an out-of-range expiry is unreadable rather than throwing downstream', () => {
    // `Number.POSITIVE_INFINITY` passes `typeof === 'number'` but yields an
    // Invalid Date, whose toISOString() throws inside the doctor line.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', expires: Number.POSITIVE_INFINITY } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('a store holding only API keys is valid with no expiry to report', () => {
    // The case the expiry filter exists for, still working: no OAuth entry at
    // all, so nothing can go stale on its own.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api-key', key: 'sk-ant-test' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.expiresAt).toBe(Number.POSITIVE_INFINITY);
    expect(result.providers).toEqual(['anthropic']);
  });
});
