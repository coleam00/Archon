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

/** A credential `pi` writes when the provider is authenticated with a raw key. */
interface StoredApiKeyCredential {
  type?: string;
  key?: string;
}

/** A single auth.json entry, before its `type` is known to be one of the two. */
type StoredEntry = StoredOAuthCredential | StoredApiKeyCredential;

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
 * The widest instant a JS `Date` can represent (±8.64e15 ms). `expires` is an
 * external value: a finite number past this bound survives `typeof` and
 * `Number.isFinite`, yet `new Date(n)` is an Invalid Date whose `toISOString()`
 * throws — inside a doctor line, not a crash path. Validate the bound here, so
 * the value never reaches the formatter.
 */
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

/** The `type` tags `pi` actually writes into auth.json. */
const OAUTH_TYPE = 'oauth';
const API_KEY_TYPE = 'api_key';

/** A representable instant — finite, and inside the `Date` range at both ends. */
function isRepresentableTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS;
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

  // `type` is the only thing that says whether a credential can authenticate,
  // and an unknown tag means Archon cannot tell. Reporting "valid" here would
  // be a green doctor over a store the runtime may not be able to use — the
  // SDK returns such an entry verbatim rather than rejecting it.
  const storedEntries = providers.map(id => entries[id] as StoredEntry | null | undefined);
  const recognized = storedEntries.every(
    entry => entry?.type === OAUTH_TYPE || entry?.type === API_KEY_TYPE
  );
  if (!recognized) {
    return { status: 'unreadable' };
  }

  const oauthEntries = storedEntries.filter(
    (entry): entry is StoredOAuthCredential => entry?.type === OAUTH_TYPE
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

  const expiries = oauthEntries.map(entry => entry.expires);

  if (!expiries.every(isRepresentableTimestamp)) {
    // At least one OAuth grant carries no representable expiry, so none of them
    // can be trusted to date the credential. An OAuth entry with no `expires`
    // is not an API key either: treating it as one reports a store no Pi
    // workflow can authenticate against as valid.
    return { status: 'unreadable' };
  }

  const expiresAt = Math.min(...expiries);

  // Which grants are actually past their expiry, for the message. The verdict
  // is aggregate (the soonest expiry decides it), but naming a still-usable
  // provider sends the operator to renew a credential that does not need it.
  // Walked per provider id so the pairing with `providers` cannot drift.
  const expiredProviders = providers.filter(id => {
    const entry = entries[id] as StoredOAuthCredential | StoredApiKeyCredential | null | undefined;
    if (entry?.type !== OAUTH_TYPE) return false;
    // Narrowed to the OAuth shape, so `expires` is in scope — and every entry
    // here already passed `isRepresentableTimestamp` above, so it is a number.
    const { expires } = entry as StoredOAuthCredential;
    return typeof expires === 'number' && options.now >= expires;
  });

  return {
    status: options.now >= expiresAt ? 'expired' : 'valid',
    providers,
    expiredProviders: options.now >= expiresAt ? expiredProviders : [],
    expiresAt,
  };
}
