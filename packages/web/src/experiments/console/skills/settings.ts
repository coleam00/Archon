import type { AssistantConfigForm, TiersForm, AliasRowForm } from '../primitives/settings';
export type {
  AssistantConfigForm,
  TierRowForm,
  TiersForm,
  SettingsScope,
  AliasRowForm,
} from '../primitives/settings';
import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';
import { TIER_ORDER, type TierName } from '../lib/tiers';

/**
 * Installation-wide settings skills: assistant config + system health/version.
 *
 * Mirrors the envVars skill (requestJson + method). Types come from the generated
 * OpenAPI spec (`@/lib/api.generated`) — never `@/lib/api` — so the console stays
 * inside its isolation boundary. Two write scopes: the /api/config/* verbs
 * persist install-wide to ~/.archon/config.yaml (no repo overrides), and the
 * /api/auth/me/ai-prefs* verbs persist the caller's per-user prefs row.
 */

export type SafeConfig = components['schemas']['SafeConfig'];
export type ConfigResponse = components['schemas']['ConfigResponse'];
export type UpdateAssistantConfigBody = components['schemas']['UpdateAssistantConfigBody'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type UpdateCheckResponse = components['schemas']['UpdateCheckResponse'];

export function getConfig(): Promise<ConfigResponse> {
  return requestJson('/api/config', 'get');
}

export function updateAssistantConfig(body: UpdateAssistantConfigBody): Promise<ConfigResponse> {
  return requestJson('/api/config/assistants', 'patch', { body });
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson('/api/health', 'get');
}

export function getUpdateCheck(): Promise<UpdateCheckResponse> {
  return requestJson('/api/update-check', 'get');
}

/**
 * Pure form → PATCH-body transform. Omits a provider's `model` when blank (so we
 * never overwrite a saved model with `''`) and drops a provider entirely when it
 * contributes no fields. Codex additionally carries `modelReasoningEffort` /
 * `webSearchMode` when set.
 *
 * Safety note: the PATCH route validates only provider *ids* and merges the body
 * into config.yaml UNFILTERED — per-field safe-filtering runs on the read path, not
 * the write path. So it matters that this function only ever attaches the codex-only
 * fields to the `codex` entry (it does); it must not leak them onto other providers.
 */
export function buildAssistantUpdate(form: AssistantConfigForm): UpdateAssistantConfigBody {
  const assistants: Record<string, Record<string, unknown>> = {};
  for (const [providerId, rawModel] of Object.entries(form.models)) {
    const entry: Record<string, unknown> = {};
    const model = rawModel.trim();
    if (model !== '') entry.model = model;
    if (providerId === 'codex') {
      if (form.modelReasoningEffort !== '') entry.modelReasoningEffort = form.modelReasoningEffort;
      if (form.webSearchMode !== '') entry.webSearchMode = form.webSearchMode;
    }
    if (Object.keys(entry).length > 0) assistants[providerId] = entry;
  }

  const body: UpdateAssistantConfigBody =
    form.assistant === '' ? {} : { assistant: form.assistant };
  if (Object.keys(assistants).length > 0) body.assistants = assistants;
  return body;
}

// ---------------------------------------------------------------------------
// Model tiers.
// ---------------------------------------------------------------------------

export type TierEntry = components['schemas']['TierEntry'];
export type TiersMap = components['schemas']['TiersConfig'];
export { TIER_ORDER, type TierName };

export type UpdateTiersBody = components['schemas']['UpdateTiersBody'];

export function updateTiers(body: UpdateTiersBody): Promise<ConfigResponse> {
  return requestJson('/api/config/tiers', 'patch', { body });
}

/**
 * Pure form → PATCH body. A row whose provider OR model is blank is sent as
 * `null` (unset → built-in default); a fully-set row carries `effort` when
 * present. The editor always sends all three tiers, so the per-key-merge route
 * cleanly applies sets and unsets in one call.
 */
export function buildTiersUpdate(form: TiersForm): UpdateTiersBody {
  const tiers: UpdateTiersBody['tiers'] = {};
  for (const tier of TIER_ORDER) {
    const row = form[tier];
    const provider = row.provider.trim();
    const model = row.model.trim();
    if (provider && model) {
      const entry: TierEntry = { provider, model };
      if (row.effort) entry.effort = row.effort;
      tiers[tier] = entry;
    } else {
      tiers[tier] = null;
    }
  }
  return { tiers };
}

export type SafeConfigAliases = SafeConfig;
export type UpdateAliasesBody = components['schemas']['UpdateAliasesBody'];
export type UpdateUserTiersBody = components['schemas']['UpdateUserTiersBody'];
export type UpdateUserAliasesBody = components['schemas']['UpdateUserAliasesBody'];

/** Install-wide @custom aliases — writes `aliases:` to ~/.archon/config.yaml. */
export function updateAliases(body: UpdateAliasesBody): Promise<ConfigResponse> {
  return requestJson('/api/config/aliases', 'patch', { body });
}

/**
 * The current web user's personal AI prefs (raw per-user layer, not merged
 * with config). Reads 401 when no web identity resolves — panels use that to
 * hide the "Just me" scope.
 */
export type UserAiPrefs = components['schemas']['UserAiPrefs'];

export function getUserAiPrefs(): Promise<UserAiPrefs> {
  return requestJson('/api/auth/me/ai-prefs', 'get');
}

export function updateUserTiers(body: UpdateUserTiersBody): Promise<UserAiPrefs> {
  return requestJson('/api/auth/me/ai-prefs/tiers', 'patch', { body });
}

export function updateUserAliases(body: UpdateUserAliasesBody): Promise<UserAiPrefs> {
  return requestJson('/api/auth/me/ai-prefs/aliases', 'patch', { body });
}

/**
 * Set the per-user default assistant + default chat model. Written atomically
 * by the server: an omitted/null model clears any previous pin, and a model
 * without a provider is rejected (400).
 */
export function updateUserDefault(
  provider: string | null,
  model: string | null
): Promise<UserAiPrefs> {
  return requestJson('/api/auth/me/ai-prefs/default', 'patch', { body: { provider, model } });
}

/** Seed editable alias rows from a saved alias map (sorted by name). */
export function seedAliasRows(map: Record<string, TierEntry> | undefined): AliasRowForm[] {
  return Object.entries(map ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => ({ name, provider: e.provider, model: e.model, effort: e.effort ?? '' }));
}

/**
 * The server's alias-name rule (`validateAliasName` in @archon/server), run in
 * the form so a bad name never costs a round trip. `scripts/alias-name-parity.test.ts`
 * keeps this copy identical — the web bundle cannot import the server's.
 */
export function aliasNameError(name: string): string | null {
  if ((TIER_ORDER as readonly string[]).includes(name)) {
    return `Alias name '${name}' is reserved (small/medium/large are tier keywords). Use a different name.`;
  }
  if (!name.startsWith('@')) {
    return `Alias name '${name}' must start with '@' (e.g. '@${name}').`;
  }
  return null;
}

/**
 * Pure form → PATCH body. Baseline names that no longer appear in the rows are
 * sent as `null` (unset — covers both deletion and rename), complete rows are
 * sent as entries, and incomplete rows (blank name/provider/model) are dropped.
 * Throws on a complete row whose name the server would reject.
 */
export function buildAliasesUpdate(
  rows: AliasRowForm[],
  baselineNames: readonly string[]
): UpdateAliasesBody {
  const aliases: UpdateAliasesBody['aliases'] = {};
  const present = new Set(rows.map(r => r.name.trim()).filter(n => n !== ''));
  for (const name of baselineNames) {
    if (!present.has(name)) aliases[name] = null;
  }
  for (const row of rows) {
    const name = row.name.trim();
    const provider = row.provider.trim();
    const model = row.model.trim();
    if (!name || !provider || !model) continue;
    const nameError = aliasNameError(name);
    if (nameError !== null) throw new Error(nameError);
    const entry: TierEntry = { provider, model };
    if (row.effort) entry.effort = row.effort;
    aliases[name] = entry;
  }
  return { aliases };
}
