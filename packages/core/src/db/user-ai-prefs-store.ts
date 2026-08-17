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
  /**
   * Per-user default CHAT model (#1998) — replaces the `large`-tier lookup at
   * the chat call-site only (workflows still resolve `large`). Only meaningful
   * together with `defaultProvider`; written atomically with it (see
   * {@link setUserDefault}).
   */
  defaultModel?: string;
}

/** Per-key patch: `null` unsets a key, an entry upserts it. */
export type UserTiersPatch = Partial<Record<TierName, RawAliasEntry | null>>;
export type UserAliasesPatch = Record<string, RawAliasEntry | null>;

/**
 * AiderDesk's `model:` slot is a case-sensitive AGENT-PROFILE NAME (no '/'
 * — see `packages/providers/src/community/aiderdesk/profile-name-lookup.md`).
 * The pre-`1fac9e3` convention was `<providerId>/<modelId>`; stale rows
 * survived the strict consumer-side split into "UnknownAiderDeskAgentProfileError
 * fires on every conversation boot". This is the producer-side deduplicator.
 *
 * Pure — takes the row JSON and the operator's current
 * `tiers.small` preset, returns a structural { tiers, rewritten, staleValues }
 * descriptor. DB-bound normalizers wrap this with persistence.
 */
export interface AiderDeskSanitizationResult {
  tiers: RawTiersConfig;
  /** Number of stale entries rewritten in place. */
  rewritten: number;
  /** Distinct model strings rewritten (informational). */
  staleValues: string[];
}

export function sanitizeAiderDeskTiersRow(
  tiers: RawTiersConfig | undefined,
  configuredSmallPreset: { provider: string; model: string }
): AiderDeskSanitizationResult {
  if (!tiers) return { tiers: {}, rewritten: 0, staleValues: [] };
  // RawTiersConfig = Partial<Record<TierName, RawAliasEntry>>. Tier-name
  // validation in `applyPatch` and `getUserAiPrefs` confirms every key is
  // `small|medium|large`; we widen locally to a string-keyed map for the
  // rewrite-pass to keep typing honest and mirror `applyPatch`'s pattern.
  const source = tiers as Record<string, RawAliasEntry | null | undefined>;
  const out: Record<string, RawAliasEntry> = {};
  const staleValues: string[] = [];
  let rewritten = 0;
  for (const [tier, entry] of Object.entries(source)) {
    if (!entry) {
      // Null entries are valid per-tier unsets; we keep them in the
      // shape-preserving rewrite path. The `unknown` cast is the
      // minimum-impact way to widen `null | undefined` → RawAliasEntry
      // without breaking the structural invariant SanitizationResult.
      out[tier] = entry as unknown as RawAliasEntry;
      continue;
    }
    // Structural invariant: aiderdesk profile names never contain '/'. A '/'
    // in `model` means a stale pre-`1fac9e3` `<provider>/<model>` literal
    // pair. Substitute with the operator's current `tiers.small`.
    const isStaleAiderDesk =
      entry.provider === 'aiderdesk' &&
      typeof entry.model === 'string' &&
      entry.model.includes('/');
    if (isStaleAiderDesk) {
      out[tier] = {
        provider: configuredSmallPreset.provider,
        model: configuredSmallPreset.model,
      };
      staleValues.push(entry.model);
      rewritten += 1;
    } else {
      out[tier] = entry;
    }
  }
  return { tiers: out as RawTiersConfig, rewritten, staleValues };
}

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
    ...(row.default_model ? { defaultModel: row.default_model } : {}),
  };
}

/** Upsert one column on the user's row (creates the row when absent). */
async function upsertPrefsColumn(
  userId: string,
  column: 'tiers' | 'aliases',
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

/**
 * Set (or clear with `null`) the user's default assistant + default chat
 * model. The two columns are ALWAYS written together: a model pin is only
 * meaningful for the provider it was set with, so preserving an old model
 * across a provider switch would let a stale pin ride the new provider.
 * Callers enforce "model requires a provider" before reaching the store.
 */
export async function setUserDefault(
  userId: string,
  provider: string | null,
  model: string | null
): Promise<void> {
  const dialect = getDialect();
  const id = dialect.generateUuid();
  try {
    await pool.query(
      `INSERT INTO remote_agent_user_ai_prefs (id, user_id, default_provider, default_model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET default_provider = $3, default_model = $4, updated_at = ${dialect.now()}`,
      [id, userId, provider, model]
    );
  } catch (err) {
    getLog().error(
      { err: err as Error, userId, column: 'default' },
      'db.user_ai_prefs_write_failed'
    );
    throw err;
  }
  getLog().debug({ userId, column: 'default' }, 'db.user_ai_prefs_set_completed');
}

/** Delete the user's prefs row entirely. Idempotent. */
export async function clearUserAiPrefs(userId: string): Promise<void> {
  await pool.query('DELETE FROM remote_agent_user_ai_prefs WHERE user_id = $1', [userId]);
  getLog().debug({ userId }, 'db.user_ai_prefs_clear_completed');
}

/**
 * Normalize one user's stored `tiers` column so stale AiderDesk literal pairs
 * (`<providerId>/<modelId>`, the pre-`1fac9e3` convention) cannot reach the
 * consumer's strict agent-profile lookup. Idempotent — clean rows are a
 * no-op. The destination preset is the OPERATOR'S CURRENT
 * `.archon/config.yaml` `tiers.small` (passed in), not a built-in default.
 *
 * Returns a structured summary so the CLI script and the unit test can
 * share semantics without a second DB round-trip.
 *
 * `apply: false` (dry-run) reports what WOULD be rewritten without writing.
 * The default is `apply: false` so a caller cannot accidentally commit;
 * the CLI script must opt in explicitly.
 */
export async function normalizeStaleAiderDeskTiers(
  userId: string,
  configuredSmallPreset: { provider: string; model: string },
  options: { apply?: boolean } = {}
): Promise<{
  userId: string;
  hadRow: boolean;
  rewritten: number;
  staleValues: string[];
  /** True if this call performed the rewrite (apply:true). */
  wrote: boolean;
}> {
  const apply = options.apply ?? false;
  let result;
  try {
    result = await pool.query<UserAiPrefsRow>(
      'SELECT tiers FROM remote_agent_user_ai_prefs WHERE user_id = $1',
      [userId]
    );
  } catch (err) {
    getLog().error({ err: err as Error, userId }, 'db.user_ai_prefs_read_failed');
    throw err;
  }
  const row = result.rows[0];
  if (!row) {
    return { userId, hadRow: false, rewritten: 0, staleValues: [], wrote: false };
  }
  const tiersParsed = parseJsonColumn(userId, 'tiers', row.tiers) as RawTiersConfig | undefined;
  const sanitized = sanitizeAiderDeskTiersRow(tiersParsed, configuredSmallPreset);
  if (sanitized.rewritten === 0) {
    getLog().debug({ userId, hadRow: true }, 'db.user_ai_prefs_aiderdesk_tiers_clean');
    return { userId, hadRow: true, rewritten: 0, staleValues: [], wrote: false };
  }
  if (!apply) {
    // Dry-run: report what would happen, leave the row untouched.
    getLog().info(
      {
        userId,
        apply: false,
        rewritten: sanitized.rewritten,
        staleValues: sanitized.staleValues,
      },
      'db.user_ai_prefs_stale_tiers_dry_run'
    );
    return {
      userId,
      hadRow: true,
      rewritten: sanitized.rewritten,
      staleValues: sanitized.staleValues,
      wrote: false,
    };
  }
  // Apply: write the sanitized JSON back as TEXT (JSON-as-TEXT column).
  try {
    await pool.query(
      `UPDATE remote_agent_user_ai_prefs
         SET tiers = $1,
             updated_at = ${getDialect().now()}
       WHERE user_id = $2`,
      [JSON.stringify(sanitized.tiers), userId]
    );
  } catch (err) {
    getLog().error({ err: err as Error, userId }, 'db.user_ai_prefs_write_failed');
    throw err;
  }
  getLog().info(
    { userId, rewritten: sanitized.rewritten, staleValues: sanitized.staleValues },
    'db.user_ai_prefs_stale_tiers_normalized'
  );
  return {
    userId,
    hadRow: true,
    rewritten: sanitized.rewritten,
    staleValues: sanitized.staleValues,
    wrote: true,
  };
}

/**
 * Scan-and-normalize helper used by the CLI script. Iterates every
 * `remote_agent_user_ai_prefs` row. Read-then-write per row keeps the
 * transaction surface small and tolerates failures on individual rows.
 * `apply: false` (default) leaves rows untouched.
 */
export async function normalizeAllStaleAiderDeskTiers(
  configuredSmallPreset: { provider: string; model: string },
  options: { apply?: boolean } = {}
): Promise<
  {
    userId: string;
    hadRow: boolean;
    rewritten: number;
    staleValues: string[];
    wrote: boolean;
    error?: string;
  }[]
> {
  const apply = options.apply ?? false;
  let result: Awaited<ReturnType<typeof pool.query<{ user_id: string }>>>;
  try {
    result = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM remote_agent_user_ai_prefs'
    );
  } catch (err) {
    getLog().error({ err: err as Error }, 'db.user_ai_prefs_scan_failed');
    throw err;
  }
  const out: {
    userId: string;
    hadRow: boolean;
    rewritten: number;
    staleValues: string[];
    wrote: boolean;
    error?: string;
  }[] = [];
  for (const r of result.rows) {
    try {
      out.push(await normalizeStaleAiderDeskTiers(r.user_id, configuredSmallPreset, { apply }));
    } catch (e) {
      out.push({
        userId: r.user_id,
        hadRow: true,
        rewritten: 0,
        staleValues: [],
        wrote: false,
        error: (e as Error).message,
      });
    }
  }
  return out;
}
