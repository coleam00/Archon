import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/**
 * Installation-wide settings skills: assistant config + system health/version.
 *
 * Mirrors the envVars skill (requestJson + method). Types come from the generated
 * OpenAPI spec (`@/lib/api.generated`) — never `@/lib/api` — so the console stays
 * inside its isolation boundary. The write path is GLOBAL only: PATCH
 * /api/config/assistants persists to ~/.archon/config.yaml (no repo overrides).
 */

export type SafeConfig = components['schemas']['SafeConfig'];
export type ConfigResponse = components['schemas']['ConfigResponse'];
export type UpdateAssistantConfigBody = components['schemas']['UpdateAssistantConfigBody'];
export type HealthResponse = components['schemas']['HealthResponse'];
export type UpdateCheckResponse = components['schemas']['UpdateCheckResponse'];

export function getConfig(): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config');
}

export function updateAssistantConfig(body: UpdateAssistantConfigBody): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config/assistants', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health');
}

export function getUpdateCheck(): Promise<UpdateCheckResponse> {
  return requestJson<UpdateCheckResponse>('/api/update-check');
}

/**
 * Editable assistant form state. `models` is providerId → free-text model (model
 * strings are intentionally unvalidated — the SDK ships models faster than Archon
 * can enumerate them). The codex-only reasoning/web-search fields are flat here
 * and only attached to the codex entry by `buildAssistantUpdate`.
 */
export interface AssistantConfigForm {
  assistant: string;
  models: Record<string, string>;
  modelReasoningEffort: string;
  webSearchMode: string;
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

  const body: UpdateAssistantConfigBody = { assistant: form.assistant };
  if (Object.keys(assistants).length > 0) body.assistants = assistants;
  return body;
}

// ---------------------------------------------------------------------------
// Model tiers. Types inlined (mirroring server/.../config.schemas.ts) until a
// regen lands TiersConfig / UpdateTiersBody / SafeConfig.tiers in
// @/lib/api.generated — same convention as skills/github.ts. Migrate to
// `components['schemas']['TiersConfig']` etc. once the spec is regenerated.
// ---------------------------------------------------------------------------

/**
 * A tier preset as the UI handles it. `thinking` is intentionally omitted — there
 * is no UI control for it, and the PATCH /api/config/tiers handler drops it on
 * write, so saving a tier here clears any `thinking` set in config.yaml. Known
 * limitation (advanced; rare).
 */
export interface TierEntry {
  provider: string;
  model: string;
  effort?: string;
}

export interface TiersMap {
  small?: TierEntry;
  medium?: TierEntry;
  large?: TierEntry;
}

/** `SafeConfig` + the tier fields not yet in the generated spec. */
export type SafeConfigTiers = SafeConfig & { tiers?: TiersMap; tierDefaults?: TiersMap };

export interface UpdateTiersBody {
  tiers: { small?: TierEntry | null; medium?: TierEntry | null; large?: TierEntry | null };
}

export function updateTiers(body: UpdateTiersBody): Promise<ConfigResponse> {
  return requestJson<ConfigResponse>('/api/config/tiers', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export type TierName = 'small' | 'medium' | 'large';
export const TIER_ORDER: readonly TierName[] = ['small', 'medium', 'large'];

export interface TierRowForm {
  provider: string; // '' = unset (falls back to the built-in default)
  model: string;
  effort: string;
}

export type TiersForm = Record<TierName, TierRowForm>;

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
      const effort = row.effort.trim();
      if (effort) entry.effort = effort;
      tiers[tier] = entry;
    } else {
      tiers[tier] = null;
    }
  }
  return { tiers };
}
