/**
 * Storage for per-user AI preferences (Phase 3) — personal model tiers,
 * `@custom` aliases, and default assistant. NON-encrypted: model names are
 * not secrets, so this mirrors the codebase_env_vars store (pool/$N/dialect),
 * not the encrypted provider-key store. One row per user (`UNIQUE(user_id)`).
 *
 * `tiers` / `aliases` are JSON-as-TEXT columns — `JSON.stringify` on write,
 * `JSON.parse` on read — so SQLite and Postgres behave identically. An empty
 * map is persisted as NULL (never `'{}'`).
 *
 * Validation of tier names / alias names / providers belongs to the callers
 * (routes + CLI) — the store is a dumb per-key merge.
 */
import { pool, getDialect } from './connection';
import { createLogger } from '@archon/paths';
import type {
  RawAliasEntry,
  RawAliasesConfig,
  RawTiersConfig,
  TierName,
} from '@archon/workflows/model-validation';
import type { UserAiPrefsRow } from '../schemas/user-ai-prefs-row';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.user-ai-prefs');
  return cachedLog;
}

/** A user's stored AI preferences. Absent fields mean "no override". */
export interface UserAiPrefs {
  tiers?: RawTiersConfig;
  aliases?: RawAliasesConfig;
  defaultProvider?: string;
}

/** Per-key patch: `null` unsets a key, an entry upserts it. */
export type UserTiersPatch = Partial<Record<TierName, RawAliasEntry | null>>;
export type UserAliasesPatch = Record<string, RawAliasEntry | null>;

function parseJsonColumn(userId: string, column: string, raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // A corrupt column must not break model resolution — log and behave as unset.
    getLog().error({ err: err as Error, userId, column }, 'db.user_ai_prefs_parse_failed');
    return undefined;
  }
}

/** Fetch a user's AI prefs. Returns `{}` when the user has no row. */
export async function getUserAiPrefs(userId: string): Promise<UserAiPrefs> {
  let result: Awaited<ReturnType<typeof pool.query<UserAiPrefsRow>>>;
  try {
    result = await pool.query<UserAiPrefsRow>(
      'SELECT * FROM remote_agent_user_ai_prefs WHERE user_id = $1',
      [userId]
    );
  } catch (err) {
    // Log here so a query failure is distinguishable from a parse failure
    // in caller logs; callers own the fallback policy (rethrow).
    getLog().error({ err: err as Error, userId }, 'db.user_ai_prefs_read_failed');
    throw err;
  }
  const row = result.rows[0];
  if (!row) return {};
  const tiers = parseJsonColumn(userId, 'tiers', row.tiers) as RawTiersConfig | undefined;
  const aliases = parseJsonColumn(userId, 'aliases', row.aliases) as RawAliasesConfig | undefined;
  return {
    ...(tiers !== undefined ? { tiers } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    ...(row.default_provider ? { defaultProvider: row.default_provider } : {}),
  };
}

/** Upsert one column on the user's row (creates the row when absent). */
async function upsertPrefsColumn(
  userId: string,
  column: 'tiers' | 'aliases' | 'default_provider',
  value: string | null
): Promise<void> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  try {
    // `column` is a closed literal union — never user input.
    await pool.query(
      `INSERT INTO remote_agent_user_ai_prefs (id, user_id, ${column})
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET ${column} = $3, updated_at = ${dialect.now()}`,
      [id, userId, value]
    );
  } catch (err) {
    getLog().error({ err: err as Error, userId, column }, 'db.user_ai_prefs_write_failed');
    throw err;
  }
  getLog().debug({ userId, column }, 'db.user_ai_prefs_set_completed');
}

/** Serialize a merged map: empty object → NULL (never persist `'{}'`). */
function toJsonOrNull(map: Record<string, RawAliasEntry>): string | null {
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/** Apply a per-key patch (`null` = unset) on top of the stored map. */
function applyPatch(
  current: Record<string, RawAliasEntry>,
  patch: Record<string, RawAliasEntry | null | undefined>
): Record<string, RawAliasEntry> {
  const merged: Record<string, RawAliasEntry> = {};
  for (const [name, entry] of Object.entries(current)) {
    if (patch[name] !== null) merged[name] = entry;
  }
  for (const [name, entry] of Object.entries(patch)) {
    if (entry !== null && entry !== undefined) merged[name] = entry;
  }
  return merged;
}

/**
 * Per-key merge of the user's tier overrides (`null` unsets a tier).
 *
 * KNOWN LIMITATION: the merge is a non-atomic read-modify-write — two
 * concurrent saves by the SAME user (double-click, two tabs) can drop the
 * other write's keys. Last-write-wins on a single user's own preferences is
 * an acceptable failure mode for now; revisit with a transaction/`FOR UPDATE`
 * (or SQL-side JSON merge on Postgres) if the multi-user smoke surfaces it.
 */
export async function setUserTiers(userId: string, patch: UserTiersPatch): Promise<void> {
  const current = (await getUserAiPrefs(userId)).tiers ?? {};
  const merged = applyPatch(current as Record<string, RawAliasEntry>, patch);
  await upsertPrefsColumn(userId, 'tiers', toJsonOrNull(merged));
}

/**
 * Per-key merge of the user's `@custom` aliases (`null` unsets an alias).
 * Same non-atomic read-modify-write caveat as {@link setUserTiers}.
 */
export async function setUserAliases(userId: string, patch: UserAliasesPatch): Promise<void> {
  const current = (await getUserAiPrefs(userId)).aliases ?? {};
  const merged = applyPatch(current, patch);
  await upsertPrefsColumn(userId, 'aliases', toJsonOrNull(merged));
}

/** Set (or clear with `null`) the user's default assistant. */
export async function setUserDefaultProvider(
  userId: string,
  provider: string | null
): Promise<void> {
  await upsertPrefsColumn(userId, 'default_provider', provider);
}

/** Delete the user's prefs row entirely. Idempotent. */
export async function clearUserAiPrefs(userId: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_user_ai_prefs WHERE user_id = $1', [userId]);
  getLog().debug({ userId }, 'db.user_ai_prefs_clear_completed');
}
