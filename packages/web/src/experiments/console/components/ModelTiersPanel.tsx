import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { SettingsSection } from './SettingsSection';
import { ScopeToggle } from './ScopeToggle';

// Field styling mirrors AssistantConfigPanel (design v5 .set-input / .set-select):
// mono fields on the page surface with a magenta focus ring.
const INPUT_CLASS =
  'w-full rounded-[9px] border border-border bg-surface px-3.5 py-[11px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';
const SELECT_CLASS =
  'w-full cursor-pointer appearance-none rounded-[9px] border border-border bg-surface-elevated py-[11px] pl-3.5 pr-8 font-mono text-[13px] font-semibold text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

/** Relative wrapper that overlays the design chevron on an appearance-none select. */
function SelectShell({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute right-[11px] flex text-text-tertiary"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </span>
  );
}

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
  // Pi catalog for the cost/reasoning hint. Best-effort: the server returns []
  // when the catalog can't load, and a fetch error simply means no hint.
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

  /** Cost/reasoning hint for a Pi tier model, or null when not applicable. */
  const piHint = (row: TierRowForm): string | null => {
    if (row.provider !== 'pi' || piModels === undefined) return null;
    const m = piModels.find(x => x.ref === row.model.trim());
    if (!m) return null;
    const ctx = `${String(Math.round(m.contextWindow / 1000))}k ctx`;
    return `$${String(m.cost.input)}/M in · $${String(m.cost.output)}/M out${m.reasoning ? ' · reasoning' : ''} · ${ctx}`;
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
          const hint = piHint(row);
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
                    setRow(tier, { provider: e.target.value });
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
              <input
                value={row.model}
                onChange={e => {
                  setRow(tier, { model: e.target.value });
                }}
                disabled={unset}
                placeholder={
                  unset ? `default: ${defaultHint(cfg, tier, scope)}` : 'model (e.g. opus, gpt-5.5)'
                }
                className={`${INPUT_CLASS} min-w-[160px] flex-1 ${unset ? 'opacity-50' : ''}`}
              />
              <input
                value={row.effort}
                onChange={e => {
                  setRow(tier, { effort: e.target.value });
                }}
                disabled={unset}
                placeholder="effort"
                className={`${INPUT_CLASS} w-[110px] shrink-0 ${unset ? 'opacity-50' : ''}`}
              />
              {hint !== null ? (
                <p className="w-full font-mono text-[10.5px] text-text-tertiary">{hint}</p>
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
