/**
 * Credential-validity reader for the Pi auth store (#3274).
 *
 * `checkPi` used to report `pass` when `~/.pi/agent/auth.json` merely existed.
 * A Pi OAuth grant that expired months ago also has its file on disk, so an
 * install whose every Pi workflow failed still got a green doctor — the file's
 * presence is necessary, not sufficient.
 *
 * The reader lives in `@archon/providers`, next to the Pi SDK whose shapes and
 * acceptance rules it mirrors; the CLI deliberately has no Pi SDK dependency.
 * These tests therefore pin the SDK-facing half: every shape the SDK's
 * `auth-storage.ts` `load()` refuses must land on `unreadable`, and every shape
 * it accepts — including a keyless `api_key` record whose key comes from
 * provider-scoped env — must stay `valid`.
 *
 * No network probe, no scanning of other tools' credential stores.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Credential } from '@earendil-works/pi-ai';
import { trackTempRoots } from '@archon/paths/test-utils';
import { readPiAuthValidity } from './auth-status';

/**
 * The credential shapes are imported from the SDK, not copied. If Pi renames a
 * field or drops one, this literal stops compiling and the drift fails a build
 * instead of shipping a reader that quietly disagrees with the runtime.
 */
const SDK_SHAPE_PIN: Credential[] = [
  { type: 'api_key', key: 'sk-stored' },
  { type: 'api_key', env: { ANTHROPIC_API_KEY: 'value' } },
  { type: 'oauth', access: 'a', refresh: 'r', expires: 1_790_000_000_000 },
];

/**
 * One temp root per test, torn down by the shared helper. Registering at
 * creation rather than removing at the end of the test body means a failed
 * assertion still gets its fixture cleaned up, and the removal stays off the
 * test's own time budget.
 */
const trackTempRoot = trackTempRoots();

let dir: string;

beforeEach(() => {
  dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-pi-auth-')));
});

/** One OAuth credential, in the shape `pi /login` writes. */
function oauthEntry(expires: number): Credential {
  return {
    type: 'oauth',
    access: 'stored-access-token',
    refresh: 'stored-refresh-token',
    expires,
  };
}

test('the copied credential shape still matches the SDK', () => {
  // `auth-status.ts` imports its types from `@earendil-works/pi-ai`, so this
  // literal is the only copy left in the repo. Compiling it against the SDK's
  // `Credential` is what keeps the reader from drifting out of sync with what
  // the runtime loads.
  expect(SDK_SHAPE_PIN).toHaveLength(3);
  expect(SDK_SHAPE_PIN.map(entry => entry.type)).toEqual(['api_key', 'api_key', 'oauth']);
});

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
      JSON.stringify({ openrouter: { type: 'api_key', key: 'sk-stored' } })
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
    // `Number.POSITIVE_INFINITY` passes `typeof === 'number'` but JSON.stringify
    // turns it into `null`, so the store is rejected as a *missing* field — the
    // Date range is never exercised. A finite value past ±8.64e15 is the one
    // that reaches `new Date(...)` and must be rejected by the reader itself.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', expires: 8_640_000_000_000_001 } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('a negative out-of-range expiry is unreadable too', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', expires: -8_640_000_000_000_001 } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an api_key entry is valid by definition, as the SDK spells it', () => {
    // `ApiKeyCredential.type` is `"api_key"` — underscore, per
    // @earendil-works/pi-ai `dist/auth/types.d.ts` and the runtime writes in
    // pi-coding-agent `dist/core/auth-storage.js`. Not `"api-key"`.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.expiresAt).toBe(Number.POSITIVE_INFINITY);
  });

  test('an entry of an unrecognized type is unreadable, not silently valid', () => {
    // `type` is the only thing that says whether a credential can authenticate.
    // An unknown tag means Archon cannot tell, and the SDK's `read()` returns
    // such an entry verbatim — so "valid" here would be a green doctor over a
    // store the runtime may not be able to use.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'totally-made-up', key: 'sk-x' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an entry with no type at all is unreadable', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: { key: 'sk-x' } }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('only the expired providers are named when the store is mixed', () => {
    // One grant expired in June, another is good until next year. The verdict is
    // aggregate (`expired`), but the message must not send the operator to
    // renew a grant that is still usable.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: oauthEntry(Date.UTC(2026, 5, 8)),
        'github-copilot': oauthEntry(Date.UTC(2027, 0, 1)),
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('expired');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.providers).toEqual(['anthropic', 'github-copilot']);
    expect(result.expiredProviders).toEqual(['anthropic']);
    // The reported expiry is still the soonest across all grants.
    expect(result.expiresAt).toBe(Date.UTC(2026, 5, 8));
  });

  test('every provider is named when every grant has expired', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: oauthEntry(Date.UTC(2026, 5, 8)),
        'github-copilot': oauthEntry(Date.UTC(2026, 6, 1)),
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('expired');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.expiredProviders).toEqual(['anthropic', 'github-copilot']);
  });

  test('a still-valid store names no expired providers', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: oauthEntry(Date.UTC(2027, 0, 1)) })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid' && result.status !== 'expired') {
      throw new Error('unreachable');
    }
    expect(result.expiredProviders).toEqual([]);
  });

  test('an expired API-key-only store still falls back to the full provider list', () => {
    // No OAuth grant means nothing expires, so `expiredProviders` is empty while
    // the verdict is valid — the caller's fallback to `providers` keeps the
    // message honest.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.expiredProviders).toEqual([]);
  });

  test('a store holding only API keys is valid with no expiry to report', () => {
    // The case the expiry filter exists for, still working: no OAuth entry at
    // all, so nothing can go stale on its own.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-test' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.expiresAt).toBe(Number.POSITIVE_INFINITY);
    expect(result.providers).toEqual(['anthropic']);
  });

  // --- Shapes the SDK refuses to load -------------------------------------
  //
  // Every case below is a store `auth-storage.ts`'s `load()` throws away, so Pi
  // cannot authenticate against it. Before this reader moved into providers,
  // checking only the `type` tag let all of them through as `valid`.

  test('an OAuth entry with no access or refresh token is unreadable', () => {
    // The SDK requires string `access` and `refresh`. A grant that carries only
    // a future `expires` has no token to spend, yet the `type`-only check read
    // it as a usable API-key-only store.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'oauth', expires: Date.UTC(2027, 0, 1) } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an OAuth entry whose tokens are not strings is unreadable', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { type: 'oauth', access: 17, refresh: 'r', expires: Date.UTC(2027, 0, 1) },
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an api_key entry whose key is not a string is unreadable', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 17 } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an api_key entry whose env values are not strings is unreadable', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant', env: { ACCOUNT: 1 } } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('an api_key entry that is an array is unreadable', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: ['not', 'a', 'credential'] })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  test('a null credential is unreadable', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: null }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });

  // --- Shapes the SDK accepts that must stay valid ------------------------

  test('a keyless api_key entry stays valid: the SDK permits it', () => {
    // `ApiKeyCredential.key` is optional, and the key can be supplied at
    // resolution time from the provider-scoped `env` or a `!command` value.
    // Rejecting it here would make doctor stricter than the runtime and fail a
    // store that works.
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key' } }));

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
  });

  test('an api_key entry with an empty-string key stays valid', () => {
    // `typeof '' === 'string'`, so the SDK accepts the shape. Whether the empty
    // key authenticates is the runtime's business, not a doctor verdict.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: '' } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
  });

  test('an api_key entry with an empty env map stays valid', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', env: {} } })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
  });

  test('an api_key entry carrying provider-scoped env stays valid', () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        cloudflare: { type: 'api_key', env: { CLOUDFLARE_ACCOUNT_ID: 'account' } },
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
  });

  test('a store whose every entry is usable is valid even when mixed', () => {
    // A usable OAuth grant next to a keyless api_key record: the aggregate
    // verdict is `valid` and only the OAuth grant can go stale.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: oauthEntry(Date.UTC(2027, 0, 1)),
        openrouter: { type: 'api_key' },
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('valid');
    if (result.status !== 'valid') throw new Error('unreachable');
    expect(result.expiresAt).toBe(Date.UTC(2027, 0, 1));
    expect(result.expiredProviders).toEqual([]);
  });

  test('one unusable entry poisons the whole store', () => {
    // A broken record next to a good grant is still a store the SDK refuses to
    // load, so neither grant can be reported usable.
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: oauthEntry(Date.UTC(2027, 0, 1)),
        broken: { type: 'oauth', expires: Date.UTC(2027, 0, 1) },
      })
    );

    const result = readPiAuthValidity(join(dir, 'auth.json'), { now: Date.UTC(2026, 8, 10) });

    expect(result.status).toBe('unreadable');
  });
});
