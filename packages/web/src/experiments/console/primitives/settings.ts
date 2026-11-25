import type { components } from '@/lib/api.generated';
import type { TierName } from '../lib/tiers';
type TierEntry = components['schemas']['TierEntry'];

/**
 * Editable assistant form state. `models` is providerId → free-text model (model
 * strings are intentionally unvalidated — the SDK ships models faster than Archon
 * can enumerate them). The codex-only reasoning/web-search fields are flat here
 * and only attached to the codex entry by `buildAssistantUpdate`.
 */
export interface AssistantConfigForm {
  assistant: NonNullable<components['schemas']['UpdateAssistantConfigBody']['assistant']>;
  models: Record<string, string>;
  modelReasoningEffort: string;
  webSearchMode: string;
}

export interface TierRowForm {
  provider: TierEntry['provider']; // '' = unset (falls back to the built-in default)
  model: TierEntry['model'];
  effort: NonNullable<TierEntry['effort']> | '';
}

export type TiersForm = Record<TierName, TierRowForm>;

/** The editable scope of a settings panel: install-wide config vs per-user DB prefs. */
export type SettingsScope = 'install' | 'user';

/** One editable alias row in the AliasesPanel. */
export interface AliasRowForm {
  name: string;
  provider: TierEntry['provider'];
  model: TierEntry['model'];
  effort: NonNullable<TierEntry['effort']> | '';
}
