/**
 * Credential-validity reader for the Pi auth store (#3274).
 *
 * `doctor`'s Pi check used to report `pass` when `~/.pi/agent/auth.json` merely
 * existed. A Pi OAuth grant that expired months ago also has its file on disk,
 * so an install whose every Pi workflow failed still got a green doctor — the
 * file's presence is necessary, not sufficient.
 *
 * The reader lives here, next to the Pi SDK it mirrors, for two reasons:
 *
 * 1. `@archon/providers` already owns Pi's SDK and its shapes. The CLI package
 *    deliberately does not depend on the Pi SDK, so a copy of the credential
 *    shape kept in `packages/cli` had nothing pinning it to the real thing —
 *    if Pi renamed a field, `doctor` would quietly report the wrong verdict.
 *    Importing the types from `@earendil-works/pi-ai` removes the copy.
 * 2. The acceptance rules below are the SDK's own. `auth-storage.ts`'s
 *    `load()` rejects a store whose entries do not match them, so a store
 *    `doctor` calls usable but the SDK refuses is a store that cannot
 *    authenticate anything. `doctor` should agree with the runtime.
 *
 * Scope: read the store Archon already reads and nothing else. No network probe
 * (a network failure is its own state, not an invalid credential), no scanning
 * of other tools' credential stores. Credential *values* are never returned or
 * logged — provider ids, state, and the expiry timestamp only.
 */
import { readFileSync } from 'node:fs';

import type { Credential, OAuthCredential } from '@earendil-works/pi-ai';

/** What the store says about the credentials it holds. */
export type PiAuthValidity =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'empty' }
  | {
      status: 'valid' | 'expired';
      /** Provider ids present in the store, sorted. */
      providers: string[];
      /**
       * Provider ids whose OAuth grants have expired, sorted. Empty on the
       * `valid` verdict and on an API-key-only store, where nothing expires.
       */
      expiredProviders: string[];
      /** Epoch ms of the soonest OAuth expiry among them. */
      expiresAt: number;
    };

/**
 * `expired` means the *access* token's expiry has passed — not that the
 * credential is dead. Pi refreshes an expired access token on the next use
 * while the refresh token still works, and so does Archon's own mint path
 * (`mintOAuthApiKey`), so a store reporting `expired` still authenticates.
 * Callers must not treat it as a hard failure: a false alarm on a healthy
 * install is worse than the false pass this reader replaced (#3274).
 *
 * The reader deliberately does not attempt the refresh itself. `doctor` reads
 * the store the user's own `pi /login` wrote; Archon's refresh path
 * (`getOAuthApiKey` → `user-provider-key-store`) reads a *different* store —
 * the encrypted per-user blob in Archon's database — and a refresh rotates
 * the token server-side, invalidating the old refresh token. A read-only
 * diagnostic must not perform a credential-rotating network write it has no
 * way to persist.
 */

/**
 * The widest instant a JS `Date` can represent (±8.64e15 ms). `expires` is an
 * external value: a finite number past this bound survives `typeof` and
 * `Number.isFinite`, yet `new Date(n)` is an Invalid Date whose `toISOString()`
 * throws — inside a doctor line, not a crash path. Validate the bound here, so
 * the value never reaches the formatter.
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/** A representable instant — finite, and inside the `Date` range at both ends. */
function isRepresentableTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS;
}

/**
 * Whether the SDK would accept this stored credential.
 *
 * Mirrors the acceptance rules in `auth-storage.ts`'s `load()` (pi-coding-agent
 * 0.84.4): an `api_key` record is usable when its `key` is absent-or-string and
 * its provider-scoped `env` values are absent-or-strings; an `oauth` record is
 * usable when it carries string `access`, string `refresh`, and a finite
 * `expires`. Anything else is a store the SDK refuses to load, so it cannot
 * authenticate a request and `doctor` must not call it usable.
 *
 * A keyless `api_key` record stays valid: the SDK permits it, and the key can
 * be supplied at resolution time from the provider-scoped `env` or a `!command`
 * value. Rejecting it here would make `doctor` stricter than the runtime and
 * fail a store that works.
 */
function isUsableStoredCredential(entry: Credential): boolean {
  if (entry.type === 'oauth') {
    return (
      typeof entry.access === 'string' &&
      typeof entry.refresh === 'string' &&
      isRepresentableTimestamp(entry.expires)
    );
  }
  if (entry.type === 'api_key') {
    const keyIsUsable = entry.key === undefined || typeof entry.key === 'string';
    const envIsUsable =
      entry.env === undefined ||
      (typeof entry.env === 'object' &&
        entry.env !== null &&
        !Array.isArray(entry.env) &&
        Object.values(entry.env).every((value: unknown) => typeof value === 'string'));
    return keyIsUsable && envIsUsable;
  }
  // An unknown `type` tag: Archon cannot tell what this is, and neither can the
  // SDK. Reporting "valid" here would be a green doctor over a store the runtime
  // may not be able to use.
  return false;
}

/**
 * Decide validity from the store's contents at a given instant.
 *
 * `now` is injectable so the expiry boundary is testable without waiting for
 * the clock — the same reason `mintOAuthApiKey` compares against `Date.now()`
 * at the call site.
 *
 * An OAuth grant counts as expired at exactly its expiry (`>=`), matching the
 * mint path in `packages/providers/src/oauth.ts`.
 */
export function readPiAuthValidity(authJsonPath: string, options: { now: number }): PiAuthValidity {
  let raw: string;
  try {
    raw = readFileSync(authJsonPath, 'utf8');
  } catch (err) {
    // Only a genuinely absent file is `missing`. A read that failed for any
    // other reason (EISDIR when auth.json is a directory, EACCES on a store
    // another user owns, ...) is its own state: reporting it as missing sends
    // the operator looking for a `pi /login` that cannot fix it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'unreadable' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unreadable' };
  }

  const entries = parsed as Record<string, unknown>;
  const providers = Object.keys(entries).sort();
  if (providers.length === 0) {
    return { status: 'empty' };
  }

  // Every entry must be a credential the SDK would load. The `type` tag alone is
  // not enough: a record that declares `type: 'oauth'` but carries no `access`
  // or `refresh` is not an API key either, and the SDK throws it away at load.
  const usableEntries = providers
    .map(id => entries[id])
    .filter(
      (entry): entry is Credential =>
        typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        isUsableStoredCredential(entry as Credential)
    );

  // One unusable record makes the whole store a store the SDK refuses to load,
  // so no grant in it can be reported usable.
  if (usableEntries.length !== providers.length) {
    return { status: 'unreadable' };
  }

  const oauthEntries = usableEntries.filter(
    (entry): entry is OAuthCredential => entry.type === 'oauth'
  );

  if (oauthEntries.length === 0) {
    // Nothing but API keys: valid by definition, with no expiry to report.
    return {
      status: 'valid',
      providers,
      expiredProviders: [],
      expiresAt: Number.POSITIVE_INFINITY,
    };
  }

  // Every OAuth entry already passed `isUsableStoredCredential`, so each carries
  // a representable expiry. Re-checked here so the invariant is local to the
  // arithmetic that depends on it, rather than resting on a distant filter.
  if (!oauthEntries.every(entry => isRepresentableTimestamp(entry.expires))) {
    return { status: 'unreadable' };
  }

  const expiresAt = Math.min(...oauthEntries.map(entry => entry.expires));

  // Which grants are actually past their expiry, for the message. The verdict
  // is aggregate (the soonest expiry decides it), but naming a still-usable
  // provider sends the operator to renew a credential that does not need it.
  // Paired by index with `providers` so the id cannot drift from its entry.
  const expiredProviders = providers.filter((_id, index) => {
    const entry = usableEntries[index];
    return entry.type === 'oauth' && options.now >= entry.expires;
  });

  return {
    status: options.now >= expiresAt ? 'expired' : 'valid',
    providers,
    expiredProviders: options.now >= expiresAt ? expiredProviders : [],
    expiresAt,
  };
}
