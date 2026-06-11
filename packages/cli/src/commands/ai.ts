/**
 * `archon ai` — per-user AI-provider credentials AND install-wide model config.
 *
 *   archon ai key set <provider>   Connect an API key (read from masked prompt or piped stdin)
 *   archon ai list                 List connected providers (metadata only, no secrets)
 *   archon ai logout <provider>    Disconnect a provider
 *   archon ai login <provider>     Connect a subscription (claude/copilot) via OAuth
 *   archon ai tier set|list|unset  Edit small/medium/large tier presets (config, not a credential)
 *   archon ai alias set|list|unset Edit @custom model aliases (config, not a credential)
 *   archon ai default <provider>   Set the default assistant (config, not a credential)
 *
 * The CREDENTIAL commands (key/list/logout/login) are gated on
 * TOKEN_ENCRYPTION_KEY (isPerUserProviderKeysEnabled); solo installs keep reading
 * provider keys from the environment unchanged. The CONFIG commands
 * (tier/alias/default) write ~/.archon/config.yaml and are ungated — they work on
 * every install. With `--scope user` they instead write the caller's per-user
 * prefs row (Phase 3) resolved via the CLI identity — needs no encryption key
 * (prefs aren't secrets) but does need a resolvable ARCHON_USER_ID/$USER.
 *
 * The API key is NEVER taken from argv (it would leak into shell history and the
 * process list). It is read from a masked `@clack/prompts` password input on a
 * TTY, or from piped stdin (`echo $KEY | archon ai key set openrouter`).
 *
 * CLI identity mirrors `archon auth github`: ARCHON_USER_ID (explicit) else
 * $USER/$USERNAME, resolved to a stable Archon user via the 'cli' platform
 * identity so a connected key attaches to the same user across invocations.
 */
import { password, text, isCancel, cancel } from '@clack/prompts';
import { createLogger } from '@archon/paths';
import {
  isPerUserProviderKeysEnabled,
  persistProviderApiKey,
  listUserProviderKeys,
  deleteUserProviderKey,
  listConnectableVendors,
  isConnectableVendor,
  normalizeCredentialVendor,
  LEGACY_VENDOR_ALIASES,
  SUBSCRIPTION_PROVIDERS,
  startOAuth,
  pollOAuth,
  loadConfig,
  updateGlobalConfig,
  getUserAiPrefs,
  setUserTiers,
  setUserAliases,
  setUserDefaultProvider,
  type TiersPatch,
  type UserAiPrefs,
} from '@archon/core';
import { isRegisteredProvider, getProviderInfoList } from '@archon/providers';
import {
  TIER_NAMES,
  buildAiProfile,
  isEffortValidForProvider,
  isTierName as isTierNameStrict,
  validEffortsForProvider,
} from '@archon/workflows/model-validation';
import type { TierName, RawAliasEntry } from '@archon/workflows/model-validation';
import * as userDb from '@archon/core/db/users';
import { resolveCliUserId } from './auth';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.ai');
  return cachedLog;
}

function knownProvidersList(): string {
  return listConnectableVendors().join(', ');
}

/**
 * Normalize a (possibly legacy agent-keyed) credential id and tell the user
 * when the stored id differs from what they typed (`claude` → `anthropic`).
 */
function resolveVendorArg(provider: string): string {
  const vendor = normalizeCredentialVendor(provider);
  if (provider in LEGACY_VENDOR_ALIASES) {
    console.log(`(Credential ids are vendor-keyed now: '${provider}' → '${vendor}'.)`);
  }
  return vendor;
}

/** Print the gate explanation and return false when per-user keys are off. */
function ensureEnabled(): boolean {
  if (!isPerUserProviderKeysEnabled()) {
    console.error(
      'Per-user AI provider keys are not enabled on this install.\n' +
        'Set TOKEN_ENCRYPTION_KEY (64-char hex) to enable encrypted per-user credentials.\n' +
        'Solo installs keep reading keys (CLAUDE_API_KEY / OPENAI_API_KEY / …) from the environment.'
    );
    return false;
  }
  return true;
}

/** Resolve the CLI identity to an Archon user row, or print why we can't. */
async function resolveUser(): Promise<{ id: string } | null> {
  const cliId = resolveCliUserId();
  if (!cliId) {
    console.error('Could not determine your CLI identity. Set ARCHON_USER_ID (or $USER).');
    return null;
  }
  try {
    return await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
  } catch (err) {
    getLog().error({ err: err as Error }, 'cli.ai_resolve_user_failed');
    console.error(`✗ Could not resolve your Archon user: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read the secret from piped stdin (non-TTY) or a masked prompt — never argv.
 * Returns `null` when there is no usable key (prompt cancelled, or empty stdin —
 * the message is printed here); a non-null result is always a non-blank key.
 */
async function readApiKey(provider: string): Promise<string | null> {
  if (!process.stdin.isTTY) {
    const piped = (await Bun.stdin.text()).trim();
    if (!piped) {
      console.error('No API key provided on stdin.');
      return null;
    }
    return piped;
  }
  const entered = await password({
    message: `Paste your API key for '${provider}':`,
    validate: v => (v?.trim() ? undefined : 'API key must not be empty.'),
  });
  if (isCancel(entered)) {
    cancel('Cancelled.');
    return null;
  }
  return entered.trim();
}

export async function aiKeySetCommand(provider: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!provider) {
    console.error('Usage: archon ai key set <provider>');
    console.error(`Providers: ${knownProvidersList()}`);
    return 1;
  }
  const vendor = resolveVendorArg(provider);
  if (!isConnectableVendor(vendor)) {
    console.error(`Unknown provider '${provider}'. Known: ${knownProvidersList()}.`);
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  const apiKey = await readApiKey(vendor);
  if (apiKey === null) return 1; // cancelled or empty (message already printed)

  try {
    const result = await persistProviderApiKey(user.id, vendor, apiKey);
    console.log(
      `✓ Stored an ${result.kind} for '${result.provider}' (encrypted). ` +
        'It will be injected into your runs and chats.'
    );
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, provider }, 'cli.ai_key_set_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

export async function aiListCommand(): Promise<number> {
  if (!ensureEnabled()) return 1;
  const user = await resolveUser();
  if (!user) return 1;

  try {
    const rows = await listUserProviderKeys(user.id);
    if (rows.length === 0) {
      console.log('No AI provider keys connected. Add one with: archon ai key set <provider>');
      return 0;
    }
    console.log('Connected AI provider credentials:');
    for (const r of rows) {
      const label = r.label ? ` — ${r.label}` : '';
      console.log(`  ${r.provider}  (${r.kind})${label}`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error }, 'cli.ai_list_failed');
    console.error(`✗ Failed to list provider keys: ${(err as Error).message}`);
    return 1;
  }
}

export async function aiLogoutCommand(provider: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!provider) {
    console.error('Usage: archon ai logout <provider>');
    return 1;
  }
  // Guard typos consistently with `key set` — a misspelled provider should be a
  // visible error, not a no-op that prints "✓ Disconnected".
  const vendor = resolveVendorArg(provider);
  if (!isConnectableVendor(vendor)) {
    console.error(`Unknown provider '${provider}'. Known: ${knownProvidersList()}.`);
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  try {
    await deleteUserProviderKey(user.id, vendor);
    console.log(`✓ Disconnected '${vendor}'.`);
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, provider: vendor }, 'cli.ai_logout_failed');
    console.error(`✗ Failed to disconnect '${vendor}': ${(err as Error).message}`);
    return 1;
  }
}

function subscriptionProvidersList(): string {
  return [...SUBSCRIPTION_PROVIDERS].sort().join(', ');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `archon ai login <provider>` — connect a subscription (Claude Pro/Max,
 * ChatGPT/Codex, GitHub Copilot) via Pi's OAuth, driven in-process through the
 * bridge. Manual-code providers (claude/codex) print a URL and prompt for the
 * pasted code; device-code (copilot) prints a user-code and polls.
 */
export async function aiLoginCommand(providerArg: string | undefined): Promise<number> {
  if (!ensureEnabled()) return 1;
  if (!providerArg) {
    console.error('Usage: archon ai login <provider>');
    console.error(`Subscription providers: ${subscriptionProvidersList()}`);
    return 1;
  }
  const provider = resolveVendorArg(providerArg);
  if (!SUBSCRIPTION_PROVIDERS.has(provider)) {
    console.error(
      `Provider '${providerArg}' does not support subscription login. ` +
        `Subscription providers: ${subscriptionProvidersList()}.`
    );
    return 1;
  }
  const user = await resolveUser();
  if (!user) return 1;

  try {
    const start = await startOAuth(user.id, provider);
    if (start.mode === 'device') {
      console.log(
        `\n→ Visit ${start.verificationUri ?? '(pending)'} and enter code: ${start.userCode ?? '(pending)'}`
      );
      console.log('→ Waiting for authorization…');
      return await pollLoginLoop(start.sessionId, user.id, provider);
    }
    // manual-code (Anthropic / Codex)
    if (start.url) console.log(`\n→ Visit: ${start.url}`);
    console.log('→ Authorize in your browser, then paste the code shown back here.');
    const code = await text({
      message: 'Paste the authorization code:',
      validate: v => (v?.trim() ? undefined : 'Authorization code is required.'),
    });
    if (isCancel(code)) {
      cancel('Cancelled.');
      return 1;
    }
    return await pollLoginLoop(start.sessionId, user.id, provider, code.trim());
  } catch (err) {
    getLog().error({ err: err as Error, provider }, 'cli.ai_login_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** Poll the in-process bridge until the login is connected/failed/timed out. */
async function pollLoginLoop(
  sessionId: string,
  userId: string,
  provider: string,
  code?: string
): Promise<number> {
  const MAX_POLLS = 150; // ~5 min at 2s
  // The pasted code is submitted on the first poll only; later polls just check status.
  let pendingCode = code;
  for (let i = 0; i < MAX_POLLS; i++) {
    const res = pollOAuth(sessionId, userId, pendingCode);
    pendingCode = undefined;
    if (res.status === 'connected') {
      console.log(`\n✓ Connected '${provider}' subscription. Stored encrypted in Archon's DB.`);
      return 0;
    }
    if (res.status === 'error') {
      console.error(`\n✗ ${res.detail ?? 'Subscription login failed.'}`);
      return 1;
    }
    await sleep(2000);
  }
  console.error('\n✗ Subscription login timed out.');
  return 1;
}

// ---------------------------------------------------------------------------
// Model tiers + aliases + default assistant — install-wide config (writes
// config.yaml) OR per-user DB prefs via `--scope user` (Phase 3).
// These are NOT credentials, so there's NO `ensureEnabled` gate; the install
// scope works on every install (solo too), mirroring the ungated config routes.
// The user scope resolves the CLI identity (like `ai key set`) but needs no
// TOKEN_ENCRYPTION_KEY — prefs aren't secrets.
// ---------------------------------------------------------------------------

/** Where a tier/alias/default write should land. */
export type PrefsScope = 'install' | 'user';

function isTierName(v: string | undefined): v is TierName {
  return v !== undefined && isTierNameStrict(v);
}

/** Parse a `--scope` value; prints usage and returns null when invalid. */
export function parsePrefsScope(scope: string | undefined): PrefsScope | null {
  if (scope === undefined || scope === 'install') return 'install';
  if (scope === 'user') return 'user';
  console.error(`Invalid --scope '${scope}'. Use 'install' (default) or 'user'.`);
  return null;
}

function registeredProvidersList(): string {
  return getProviderInfoList()
    .map(p => p.id)
    .join(', ');
}

/** Validate provider + effort for a tier/alias entry; prints and returns false on error. */
function validateEntryInputs(provider: string, effort: string | undefined): boolean {
  if (!isRegisteredProvider(provider)) {
    console.error(`Unknown provider '${provider}'. Available: ${registeredProvidersList()}.`);
    return false;
  }
  if (effort !== undefined && !isEffortValidForProvider(provider, effort)) {
    console.error(
      `Invalid effort '${effort}' for provider '${provider}'. ` +
        `Valid: ${validEffortsForProvider(provider)?.join(', ') ?? '(this provider has no effort setting)'}.`
    );
    return false;
  }
  return true;
}

/** `archon ai tier set <small|medium|large> <provider> <model> [--effort <e>] [--scope user|install]` */
export async function aiTierSetCommand(
  tier: string | undefined,
  provider: string | undefined,
  model: string | undefined,
  effort: string | undefined,
  scope?: string
): Promise<number> {
  const resolvedScope = parsePrefsScope(scope);
  if (resolvedScope === null) return 1;
  if (!isTierName(tier) || !provider || !model) {
    console.error(
      'Usage: archon ai tier set <small|medium|large> <provider> <model> [--effort <effort>] [--scope user|install]'
    );
    return 1;
  }
  if (!validateEntryInputs(provider, effort)) return 1;
  const entry: RawAliasEntry = { provider, model, ...(effort ? { effort } : {}) };
  try {
    if (resolvedScope === 'user') {
      const user = await resolveUser();
      if (!user) return 1;
      await setUserTiers(user.id, { [tier]: entry });
    } else {
      const tiers: TiersPatch = {};
      tiers[tier] = entry;
      await updateGlobalConfig({ tiers });
    }
    const scopeLabel = resolvedScope === 'user' ? ' (just you)' : '';
    console.log(
      `✓ Set tier '${tier}' → ${provider}/${model}${effort ? ` (effort: ${effort})` : ''}${scopeLabel}.`
    );
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, tier, scope: resolvedScope }, 'cli.ai_tier_set_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** `archon ai tier unset <small|medium|large> [--scope user|install]` */
export async function aiTierUnsetCommand(
  tier: string | undefined,
  scope?: string
): Promise<number> {
  const resolvedScope = parsePrefsScope(scope);
  if (resolvedScope === null) return 1;
  if (!isTierName(tier)) {
    console.error('Usage: archon ai tier unset <small|medium|large> [--scope user|install]');
    return 1;
  }
  try {
    if (resolvedScope === 'user') {
      const user = await resolveUser();
      if (!user) return 1;
      await setUserTiers(user.id, { [tier]: null });
      console.log(`✓ Unset your tier '${tier}' (falls back to the install config).`);
    } else {
      const tiers: TiersPatch = {};
      tiers[tier] = null;
      await updateGlobalConfig({ tiers });
      console.log(`✓ Unset tier '${tier}' (falls back to the built-in default).`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, tier, scope: resolvedScope }, 'cli.ai_tier_unset_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Best-effort read of the CLI user's prefs for listings — `{}` when no CLI
 * identity resolves or the DB read fails (solo installs just see config).
 */
async function readUserPrefsBestEffort(): Promise<UserAiPrefs> {
  const cliId = resolveCliUserId();
  if (!cliId) return {};
  try {
    const user = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    return await getUserAiPrefs(user.id);
  } catch (err) {
    getLog().warn({ err: err as Error }, 'cli.ai_user_prefs_read_failed');
    // Visible notice so the listing isn't mistaken for "you have no overrides".
    console.error('(could not read your per-user prefs — showing install config only)');
    return {};
  }
}

/** `archon ai tier list [--json]` — show install + per-user scopes and the effective value. */
export async function aiTierListCommand(json?: boolean): Promise<number> {
  try {
    const config = await loadConfig();
    const configured = config.tiers ?? {};
    const userPrefs = await readUserPrefsBestEffort();
    const userTiers = userPrefs.tiers ?? {};
    const effectiveAssistant = userPrefs.defaultProvider ?? config.assistant;
    // No options → just the built-in tier-defaults for the default provider.
    // Degrade like the route's `tierDefaultsFor` (buildAiProfile ~never throws
    // with no aliases, but a defaults lookup must not fail the whole listing).
    let defaults: Record<string, RawAliasEntry> = {};
    try {
      defaults = buildAiProfile(effectiveAssistant).aliases;
    } catch (err) {
      getLog().warn({ err: err as Error }, 'cli.ai_tier_list_defaults_failed');
    }
    const toEntry = (
      set: RawAliasEntry | undefined
    ): { provider: string; model: string; effort?: string } | null =>
      set ? { provider: set.provider, model: set.model, effort: set.effort } : null;
    const rows = TIER_NAMES.map(tier => {
      const installEntry = toEntry(configured[tier]);
      const userEntry = toEntry(userTiers[tier]);
      const def = toEntry(defaults[tier]);
      return {
        tier,
        configured: installEntry,
        user: userEntry,
        default: def,
        effective: userEntry ?? installEntry ?? def,
      };
    });

    if (json) {
      console.log(
        JSON.stringify(
          {
            defaultAssistant: config.assistant,
            userDefaultAssistant: userPrefs.defaultProvider ?? null,
            tiers: rows,
          },
          null,
          2
        )
      );
      return 0;
    }

    const assistantSuffix = userPrefs.defaultProvider
      ? `${config.assistant}; yours: ${userPrefs.defaultProvider}`
      : config.assistant;
    console.log(`Model tiers (default assistant: ${assistantSuffix}):`);
    for (const r of rows) {
      const label = r.tier.padEnd(7);
      if (r.user) {
        const eff = r.user.effort ? ` (effort: ${r.user.effort})` : '';
        console.log(`  ${label} ${r.user.provider}/${r.user.model}${eff} [just you]`);
      } else if (r.configured) {
        const eff = r.configured.effort ? ` (effort: ${r.configured.effort})` : '';
        console.log(`  ${label} ${r.configured.provider}/${r.configured.model}${eff}`);
      } else if (r.default) {
        console.log(`  ${label} (default: ${r.default.provider}/${r.default.model})`);
      } else {
        console.log(`  ${label} (unset)`);
      }
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error }, 'cli.ai_tier_list_failed');
    console.error(`✗ Failed to list tiers: ${(err as Error).message}`);
    return 1;
  }
}

/** Validate a custom alias name: must start with '@' and not shadow a tier keyword. */
function validateAliasName(name: string): boolean {
  if ((TIER_NAMES as readonly string[]).includes(name)) {
    console.error(
      `Alias name '${name}' is reserved (small/medium/large are tier keywords). Use a different name.`
    );
    return false;
  }
  if (!name.startsWith('@')) {
    console.error(`Alias name '${name}' must start with '@' (e.g. '@${name}').`);
    return false;
  }
  return true;
}

/** `archon ai alias set <@name> <provider> <model> [--effort <e>] [--scope user|install]` */
export async function aiAliasSetCommand(
  name: string | undefined,
  provider: string | undefined,
  model: string | undefined,
  effort: string | undefined,
  scope?: string
): Promise<number> {
  const resolvedScope = parsePrefsScope(scope);
  if (resolvedScope === null) return 1;
  if (!name || !provider || !model) {
    console.error(
      'Usage: archon ai alias set <@name> <provider> <model> [--effort <effort>] [--scope user|install]'
    );
    return 1;
  }
  if (!validateAliasName(name)) return 1;
  if (!validateEntryInputs(provider, effort)) return 1;
  const entry: RawAliasEntry = { provider, model, ...(effort ? { effort } : {}) };
  try {
    if (resolvedScope === 'user') {
      const user = await resolveUser();
      if (!user) return 1;
      await setUserAliases(user.id, { [name]: entry });
    } else {
      await updateGlobalConfig({ aliases: { [name]: entry } });
    }
    const scopeLabel = resolvedScope === 'user' ? ' (just you)' : '';
    console.log(
      `✓ Set alias '${name}' → ${provider}/${model}${effort ? ` (effort: ${effort})` : ''}${scopeLabel}.`
    );
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, name, scope: resolvedScope }, 'cli.ai_alias_set_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** `archon ai alias unset <@name> [--scope user|install]` */
export async function aiAliasUnsetCommand(
  name: string | undefined,
  scope?: string
): Promise<number> {
  const resolvedScope = parsePrefsScope(scope);
  if (resolvedScope === null) return 1;
  if (!name) {
    console.error('Usage: archon ai alias unset <@name> [--scope user|install]');
    return 1;
  }
  try {
    if (resolvedScope === 'user') {
      const user = await resolveUser();
      if (!user) return 1;
      await setUserAliases(user.id, { [name]: null });
      console.log(`✓ Unset your alias '${name}'.`);
    } else {
      await updateGlobalConfig({ aliases: { [name]: null } });
      console.log(`✓ Unset alias '${name}'.`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, name, scope: resolvedScope }, 'cli.ai_alias_unset_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

/** `archon ai alias list [--json]` — install (merged repo>global) + per-user aliases. */
export async function aiAliasListCommand(json?: boolean): Promise<number> {
  try {
    const config = await loadConfig();
    const installAliases = config.aliases ?? {};
    const userPrefs = await readUserPrefsBestEffort();
    const userAliases = userPrefs.aliases ?? {};
    const names = [
      ...new Set([...Object.keys(installAliases), ...Object.keys(userAliases)]),
    ].sort();
    const rows = names.map(name => ({
      name,
      install: installAliases[name] ?? null,
      user: userAliases[name] ?? null,
      effective: userAliases[name] ?? installAliases[name] ?? null,
    }));

    if (json) {
      console.log(JSON.stringify({ aliases: rows }, null, 2));
      return 0;
    }

    if (rows.length === 0) {
      console.log(
        'No @custom aliases configured. Add one with: archon ai alias set <@name> <provider> <model>'
      );
      return 0;
    }
    console.log('Model aliases:');
    for (const r of rows) {
      const e = r.effective;
      if (!e) continue;
      const eff = e.effort ? ` (effort: ${e.effort})` : '';
      const scopeLabel = r.user ? ' [just you]' : '';
      console.log(`  ${r.name.padEnd(12)} ${e.provider}/${e.model}${eff}${scopeLabel}`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error }, 'cli.ai_alias_list_failed');
    console.error(`✗ Failed to list aliases: ${(err as Error).message}`);
    return 1;
  }
}

/** `archon ai default <provider> [--scope user|install]` — set the default assistant. */
export async function aiDefaultCommand(
  provider: string | undefined,
  scope?: string
): Promise<number> {
  const resolvedScope = parsePrefsScope(scope);
  if (resolvedScope === null) return 1;
  if (!provider) {
    console.error('Usage: archon ai default <provider> [--scope user|install]');
    console.error(`Providers: ${registeredProvidersList()}`);
    return 1;
  }
  if (!isRegisteredProvider(provider)) {
    console.error(`Unknown provider '${provider}'. Available: ${registeredProvidersList()}.`);
    return 1;
  }
  try {
    if (resolvedScope === 'user') {
      const user = await resolveUser();
      if (!user) return 1;
      await setUserDefaultProvider(user.id, provider);
      console.log(`✓ Your default assistant set to '${provider}' (just you).`);
    } else {
      await updateGlobalConfig({ defaultAssistant: provider });
      console.log(`✓ Default assistant set to '${provider}'.`);
    }
    return 0;
  } catch (err) {
    getLog().error({ err: err as Error, provider, scope: resolvedScope }, 'cli.ai_default_failed');
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}
