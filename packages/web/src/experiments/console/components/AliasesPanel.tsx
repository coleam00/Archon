import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../skills';
import type {
  AliasRowForm,
  ProviderInfo,
  ProviderKeyList,
  SafeConfigAliases,
  SettingsScope,
  UserAiPrefs,
} from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { providerOptionHint } from '../lib/agent-status';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { SettingsSection } from './SettingsSection';
import { ScopeToggle } from './ScopeToggle';

// Field styling mirrors ModelTiersPanel (design v5 .set-input / .set-select).
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

/**
 * Editor for `@custom` model aliases in two scopes: "This install" writes
 * PATCH /api/config/aliases → ~/.archon/config.yaml (ungated), "Just me"
 * writes the caller's per-user prefs row via PATCH /api/auth/me/ai-prefs/aliases.
 * The "Just me" scope is hidden when the per-user prefs read fails (no web
 * identity), mirroring ModelTiersPanel. Removing a row (or renaming) sends a
 * `null` for the old name — the routes apply a per-key merge.
 */
export function AliasesPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);
  const { data: providers, error: providersError } = useEntity<ProviderInfo[]>(
    K.providers,
    skill.listProviders
  );
  const { data: userPrefs, error: userPrefsError } = useEntity<UserAiPrefs>(
    K.userAiPrefs,
    skill.getUserAiPrefs
  );
  // Agent credential matrix for readiness hints in the provider dropdowns.
  // Shares the AgentsPanel cache key (one fetch); a 401/error means no hints.
  const { data: keyData } = useEntity<ProviderKeyList>(
    K.providerConnections,
    skill.listProviderKeys
  );

  const userScopeAvailable = userPrefsError === undefined;
  const [scope, setScope] = useState<SettingsScope>('install');

  const [rows, setRows] = useState<AliasRowForm[] | null>(null);
  const baselineRef = useRef('');
  const baselineNamesRef = useRef<string[]>([]);
  useEffect(() => {
    if (config === undefined) return;
    if (scope === 'user' && userPrefs === undefined) return;
    const map =
      scope === 'user' ? userPrefs?.aliases : (config.config as SafeConfigAliases).aliases;
    const seeded = skill.seedAliasRows(map);
    setRows(seeded);
    baselineRef.current = JSON.stringify(seeded);
    baselineNamesRef.current = Object.keys(map ?? {});
  }, [config, userPrefs, scope]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Guard async setState after unmount (mirrors AgentsPanel's cards).
  const cancelledRef = useCancelledRef();

  const loadError = configError ?? providersError;
  if (loadError !== undefined) {
    return (
      <SettingsSection title="Model Aliases">
        <p className="font-mono text-[11px] text-error">{loadError.message}</p>
      </SettingsSection>
    );
  }
  if (rows === null || providers === undefined || config === undefined) {
    return (
      <SettingsSection title="Model Aliases">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const dirty = JSON.stringify(rows) !== baselineRef.current;

  const setRow = (index: number, partial: Partial<AliasRowForm>): void => {
    setRows(rs => (rs === null ? rs : rs.map((r, i) => (i === index ? { ...r, ...partial } : r))));
  };
  const removeRow = (index: number): void => {
    setRows(rs => (rs === null ? rs : rs.filter((_, i) => i !== index)));
  };
  const addRow = (): void => {
    setRows(rs =>
      rs === null
        ? rs
        : [...rs, { name: '@', provider: providers[0]?.id ?? '', model: '', effort: '' }]
    );
  };

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = skill.buildAliasesUpdate(rows, baselineNamesRef.current);
      if (scope === 'user') {
        await skill.updateUserAliases(body);
        if (cancelledRef.current) return;
        invalidate(K.userAiPrefs);
      } else {
        await skill.updateAliases(body);
        if (cancelledRef.current) return;
        invalidate(K.config);
      }
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setSaveError(e instanceof Error ? e.message : 'Failed to save aliases.');
    } finally {
      if (!cancelledRef.current) setSaving(false);
    }
  };

  return (
    <SettingsSection title="Model Aliases">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-[260px] flex-1 text-[12.5px] leading-relaxed text-text-tertiary">
          Custom <code className="font-mono">@name</code> refs usable in workflow{' '}
          <code className="font-mono">model:</code> fields (e.g.{' '}
          <code className="font-mono">@fast</code>).
          {scope === 'user' ? ' Your aliases override install aliases with the same name.' : ''}
        </p>
        {userScopeAvailable ? <ScopeToggle scope={scope} onChange={setScope} /> : null}
      </div>

      {rows.length === 0 ? (
        <p className="mb-3 font-mono text-[11px] text-text-tertiary">
          No aliases yet{scope === 'user' ? ' (just you)' : ''}.
        </p>
      ) : (
        <div className="flex flex-col gap-[11px]">
          {rows.map((row, i) => (
            <div
              // Index key is intentional: rows are positional edit buffers and
              // names are editable (a name key would remount mid-keystroke).
              key={i}
              className="flex flex-wrap items-center gap-[14px] rounded-xl border border-border bg-surface-elevated p-4"
            >
              <input
                value={row.name}
                onChange={e => {
                  setRow(i, { name: e.target.value });
                }}
                placeholder="@fast"
                aria-label="Alias name"
                className={`${INPUT_CLASS} w-[120px] shrink-0`}
              />
              <SelectShell className="w-[150px] shrink-0">
                <select
                  value={row.provider}
                  onChange={e => {
                    setRow(i, { provider: e.target.value });
                  }}
                  aria-label="Provider"
                  className={SELECT_CLASS}
                >
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
                  setRow(i, { model: e.target.value });
                }}
                placeholder="model (e.g. opus, gpt-5.5)"
                aria-label="Model"
                className={`${INPUT_CLASS} min-w-[140px] flex-1`}
              />
              <input
                value={row.effort}
                onChange={e => {
                  setRow(i, { effort: e.target.value });
                }}
                placeholder="effort"
                aria-label="Effort"
                className={`${INPUT_CLASS} w-[90px] shrink-0`}
              />
              <button
                type="button"
                onClick={() => {
                  removeRow(i);
                }}
                aria-label={`Remove alias ${row.name}`}
                className="shrink-0 rounded border border-border px-2.5 py-1.5 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-[18px] flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={addRow}
          className="rounded-[9px] border border-border px-3 py-1.5 font-mono text-[11.5px] font-semibold text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
        >
          + Add alias
        </button>
        <div className="flex items-center gap-3">
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
      </div>
    </SettingsSection>
  );
}
