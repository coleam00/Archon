import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type {
  PiModelInfo,
  ProviderInfo,
  ProviderKeyList,
  SafeConfigTiers,
  TiersForm,
  TierName,
  TierRowForm,
  SettingsScope,
  UserAiPrefs,
} from '../skills';
import { TIER_ORDER } from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { providerOptionHint } from '../lib/agent-status';
import { effortOptionsForAgent, normalizeEffortForAgent } from '../lib/model-options';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { SettingsSection } from './SettingsSection';
import { ScopeToggle } from './ScopeToggle';
import { SELECT_CLASS, SelectShell } from './SettingsFormPrimitives';
import { ModelPickerField } from './ModelPickerField';

/** Seed the editable tier form from a tier map (configured tiers only). */
function seedTiers(tiers: SafeConfigTiers['tiers']): TiersForm {
  const row = (t: TierName): TierRowForm => {
    const set = tiers?.[t];
    return { provider: set?.provider ?? '', model: set?.model ?? '', effort: set?.effort ?? '' };
  };
  return { small: row('small'), medium: row('medium'), large: row('large') };
}

/**
 * "provider/model" hint for an unset tier. Install scope falls back to the
 * built-in default; user scope falls back to the install tier first (that's
 * what an unset per-user tier resolves to), then the built-in default.
 */
function defaultHint(cfg: SafeConfigTiers, t: TierName, scope: SettingsScope): string {
  if (scope === 'user') {
    const installSet = cfg.tiers?.[t];
    if (installSet) return `${installSet.provider}/${installSet.model}`;
  }
  const d = cfg.tierDefaults?.[t];
  return d ? `${d.provider}/${d.model}` : 'built-in default';
}

/**
 * Editor for the model tiers (small/medium/large → provider/model) in two
 * scopes: "This install" writes PATCH /api/config/tiers → ~/.archon/config.yaml
 * (ungated; works on solo installs), "Just me" writes the caller's per-user
 * prefs row via PATCH /api/auth/me/ai-prefs/tiers (highest precedence at run
 * time). The "Just me" scope is hidden when GET /api/auth/me/ai-prefs 401s (no
 * web identity — solo-PAT or logged out), mirroring AgentsPanel.
 * A row left on "Default" is sent as an unset and falls back to the next layer.
 */
export function ModelTiersPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);
  const { data: providers, error: providersError } = useEntity<ProviderInfo[]>(
    K.providers,
    skill.listProviders
  );
  const { data: userPrefs, error: userPrefsError } = useEntity<UserAiPrefs>(
    K.userAiPrefs,
    skill.getUserAiPrefs
  );
  // Pi catalog for the model picker's suggestions + cost/reasoning hints.
  // Best-effort: the server returns [] when the catalog can't load, and a
  // fetch error simply means no suggestions.
  const { data: piModels } = useEntity<PiModelInfo[]>(K.piModels, skill.listPiModels);
  // Agent credential matrix for readiness hints in the provider dropdowns.
  // Shares the AgentsPanel cache key (one fetch); a 401/error means no hints.
  const { data: keyData } = useEntity<ProviderKeyList>(
    K.providerConnections,
    skill.listProviderKeys
  );

  // No web identity (401) or any other prefs read failure → install scope only,
  // so the editor never mislabels install values as "Just me".
  const userScopeAvailable = userPrefsError === undefined;
  const [scope, setScope] = useState<SettingsScope>('install');

  const [form, setForm] = useState<TiersForm | null>(null);
  const baselineRef = useRef('');
  useEffect(() => {
    if (config === undefined) return;
    if (scope === 'user' && userPrefs === undefined) return;
    const seeded =
      scope === 'user'
        ? seedTiers(userPrefs?.tiers)
        : seedTiers((config.config as SafeConfigTiers).tiers);
    setForm(seeded);
    baselineRef.current = JSON.stringify(seeded);
  }, [config, userPrefs, scope]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Guard async setState after unmount (mirrors AgentsPanel's cards).
  const cancelledRef = useCancelledRef();

  const loadError = configError ?? providersError;
  if (loadError !== undefined) {
    return (
      <SettingsSection title="Model Tiers">
        <p className="font-mono text-[11px] text-error">{loadError.message}</p>
      </SettingsSection>
    );
  }
  if (form === null || providers === undefined || config === undefined) {
    return (
      <SettingsSection title="Model Tiers">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const cfg = config.config as SafeConfigTiers;
  const dirty = JSON.stringify(form) !== baselineRef.current;

  const setRow = (t: TierName, partial: Partial<TierRowForm>): void => {
    setForm(f => (f === null ? f : { ...f, [t]: { ...f[t], ...partial } }));
  };

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      if (scope === 'user') {
        await skill.updateUserTiers(skill.buildTiersUpdate(form));
        if (cancelledRef.current) return;
        invalidate(K.userAiPrefs); // refetch re-seeds the form and clears `dirty`
      } else {
        await skill.updateTiers(skill.buildTiersUpdate(form));
        if (cancelledRef.current) return;
        invalidate(K.config); // refetch re-seeds the form and clears `dirty`
      }
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setSaveError(e instanceof Error ? e.message : 'Failed to save tiers.');
    } finally {
      if (!cancelledRef.current) setSaving(false);
    }
  };

  return (
    <SettingsSection title="Model Tiers">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-[260px] flex-1 text-[12.5px] leading-relaxed text-text-tertiary">
          Bundled workflows resolve <code className="font-mono">small</code> /{' '}
          <code className="font-mono">medium</code> / <code className="font-mono">large</code> to
          these models. Leave a row on “Default” to use the next layer’s preset.
          {scope === 'user' ? ' Your rows override the install rows for runs you start.' : ''}
        </p>
        {userScopeAvailable ? <ScopeToggle scope={scope} onChange={setScope} /> : null}
      </div>

      <div className="flex flex-col gap-[11px]">
        {TIER_ORDER.map(tier => {
          const row = form[tier];
          const unset = row.provider === '';
          const effortOptions = effortOptionsForAgent(row.provider);
          return (
            <div
              key={tier}
              className="flex flex-wrap items-center gap-[14px] rounded-xl border border-border bg-surface-elevated p-4"
            >
              <div className="w-[78px] shrink-0 text-[13.5px] font-bold capitalize text-text-primary">
                {tier}
              </div>
              <SelectShell className="w-[160px] shrink-0">
                <select
                  value={row.provider}
                  onChange={e => {
                    // Carry effort across the switch only when the new agent's
                    // vocabulary accepts it; clear it otherwise (the field
                    // hides for agents where tier effort doesn't route).
                    const provider = e.target.value;
                    setRow(tier, {
                      provider,
                      effort: normalizeEffortForAgent(provider, row.effort),
                    });
                  }}
                  className={SELECT_CLASS}
                >
                  <option value="">Default ({defaultHint(cfg, tier, scope)})</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                      {providerOptionHint(keyData?.agents, p.id)}
                    </option>
                  ))}
                </select>
              </SelectShell>
              <ModelPickerField
                // Re-key per agent so picker-internal state (Pi "show all",
                // OpenCode loaded backends) never bleeds across a switch.
                key={row.provider}
                agentId={row.provider}
                value={row.model}
                onChange={v => {
                  setRow(tier, { model: v });
                }}
                disabled={unset}
                placeholder={
                  unset ? `default: ${defaultHint(cfg, tier, scope)}` : 'model (e.g. opus, gpt-5.5)'
                }
                ariaLabel={`${tier} model`}
                className="min-w-[160px] flex-1"
                agents={keyData?.agents}
                piModels={piModels}
              />
              {effortOptions !== null ? (
                <SelectShell className="w-[110px] shrink-0">
                  <select
                    value={row.effort}
                    onChange={e => {
                      setRow(tier, { effort: e.target.value });
                    }}
                    // Currently unreachable while disabled (unset rows have no
                    // effort vocabulary), but every row control rides the
                    // shared disabled state so a future widening of `unset`
                    // can't silently skip this one.
                    disabled={unset}
                    aria-label={`${tier} effort`}
                    className={`${SELECT_CLASS} ${unset ? 'opacity-50' : ''}`}
                  >
                    <option value="">effort</option>
                    {effortOptions.map(o => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </SelectShell>
              ) : null}
            </div>
          );
        })}
      </div>

      {TIER_ORDER.filter(t => form[t].provider !== '').length === 1 ? (
        <p className="mt-3 font-mono text-[11px] text-text-tertiary">
          Heads up: only one tier is set{scope === 'user' ? ' for you' : ''} — runs asking for the
          other tiers fall back to the nearest configured preset.
        </p>
      ) : null}

      <div className="mt-[18px] flex items-center justify-end gap-3">
        {saveError !== null ? (
          <span className="font-mono text-[11px] text-error">{saveError}</span>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || saving}
          className="brand-bar rounded-[10px] px-[18px] py-2.5 text-[13px] font-bold text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </SettingsSection>
  );
}
