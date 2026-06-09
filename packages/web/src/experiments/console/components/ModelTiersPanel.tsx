import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../skills';
import type { ProviderInfo, SafeConfigTiers, TiersForm, TierName, TierRowForm } from '../skills';
import { TIER_ORDER } from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { SettingsSection } from './SettingsSection';

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

/** Seed the editable tier form from the saved config (configured tiers only). */
function seedTiers(cfg: SafeConfigTiers): TiersForm {
  const row = (t: TierName): TierRowForm => {
    const set = cfg.tiers?.[t];
    return { provider: set?.provider ?? '', model: set?.model ?? '', effort: set?.effort ?? '' };
  };
  return { small: row('small'), medium: row('medium'), large: row('large') };
}

/** "provider/model" hint for an unset tier's built-in default. */
function defaultHint(cfg: SafeConfigTiers, t: TierName): string {
  const d = cfg.tierDefaults?.[t];
  return d ? `${d.provider}/${d.model}` : 'built-in default';
}

/**
 * Editor for the install-wide model tiers (small/medium/large → provider/model).
 * Writes PATCH /api/config/tiers → ~/.archon/config.yaml. Ungated, so it works on
 * solo installs too (unlike Provider Auth). A row left on "Default" is sent as an
 * unset and falls back to the built-in preset for the default provider.
 */
export function ModelTiersPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);
  const { data: providers, error: providersError } = useEntity<ProviderInfo[]>(
    K.providers,
    skill.listProviders
  );

  const [form, setForm] = useState<TiersForm | null>(null);
  const baselineRef = useRef('');
  useEffect(() => {
    if (config === undefined) return;
    const seeded = seedTiers(config.config as SafeConfigTiers);
    setForm(seeded);
    baselineRef.current = JSON.stringify(seeded);
  }, [config]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Guard async setState after unmount (mirrors ProviderConnectionsPanel).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return (): void => {
      cancelledRef.current = true;
    };
  }, []);

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
      await skill.updateTiers(skill.buildTiersUpdate(form));
      if (cancelledRef.current) return;
      invalidate(K.config); // refetch re-seeds the form and clears `dirty`
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setSaveError(e instanceof Error ? e.message : 'Failed to save tiers.');
    } finally {
      if (!cancelledRef.current) setSaving(false);
    }
  };

  return (
    <SettingsSection title="Model Tiers">
      <p className="mb-4 text-[12.5px] leading-relaxed text-text-tertiary">
        Bundled workflows resolve <code className="font-mono">small</code> /{' '}
        <code className="font-mono">medium</code> / <code className="font-mono">large</code> to
        these models. Leave a row on “Default” to use the built-in preset.
      </p>

      <div className="flex flex-col gap-[11px]">
        {TIER_ORDER.map(tier => {
          const row = form[tier];
          const unset = row.provider === '';
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
                  <option value="">Default ({defaultHint(cfg, tier)})</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
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
                  unset ? `default: ${defaultHint(cfg, tier)}` : 'model (e.g. opus, gpt-5.5)'
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
            </div>
          );
        })}
      </div>

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
