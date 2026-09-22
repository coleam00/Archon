/**
 * Read the Pi credential store `doctor` already looks at and report what the
 * credential in it says (#3274).
 *
 * `checkPi` used to report `pass` when `~/.pi/agent/auth.json` merely existed.
 * A Pi OAuth grant that expired months ago also has its file on disk, so an
 * install whose every Pi workflow failed still got a green doctor — the file's
 * presence is necessary, not sufficient.
 *
 * Scope, per the issue: read the store Archon already reads and nothing else.
 * No network probe (a network failure is its own state, not an invalid
 * credential), no scanning of other tools' credential stores. Credential
 * *values* are never returned or logged — provider ids, state, and the expiry
 * timestamp only.
 */
import { readFileSync } from 'node:fs';

/** A credential as `pi /login` writes it into auth.json. */
interface StoredOAuthCredential {
  type?: string;
  expires?: number;
}

/** What the store says about the credentials it holds. */
export type PiAuthValidity =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'empty' }
  | {
      status: 'valid' | 'expired';
      /** Provider ids present in the store, sorted. */
      providers: string[];
      /** Epoch ms of the soonest OAuth expiry among them. */
      expiresAt: number;
    };

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
  } catch {
    return { status: 'missing' };
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

  // An API-key entry has no expiry and never goes stale on its own. Only OAuth
  // grants carry an `expires`, so only they can decide the verdict; a store
  // holding nothing but API keys is valid by definition.
  const expiries = providers
    .map(id => entries[id])
    .filter((entry): entry is StoredOAuthCredential => {
      if (typeof entry !== 'object' || entry === null) return false;
      return (entry as StoredOAuthCredential).type === 'oauth';
    })
    .map(entry => entry.expires)
    .filter((expires): expires is number => typeof expires === 'number');

  if (expiries.length === 0) {
    return { status: 'valid', providers, expiresAt: Number.POSITIVE_INFINITY };
  }

  const expiresAt = Math.min(...expiries);
  return {
    status: options.now >= expiresAt ? 'expired' : 'valid',
    providers,
    expiresAt,
  };
}
