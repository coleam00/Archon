import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as skill from '../skills';
import type { SafeConfig, ProviderInfo, AssistantConfigForm } from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { SettingsSection } from './SettingsSection';

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const WEB_SEARCH_MODES = ['disabled', 'cached', 'live'] as const;

// Design v5 (.set-input / .set-select): mono fields on the page surface with
// a magenta focus ring. Border colors ride inline styles where needed because
// the console scope's wildcard border-color rule repaints Tailwind utilities.
const INPUT_CLASS =
  'w-full rounded-[9px] border border-border bg-surface px-3.5 py-[11px] font-mono text-[13px] text-text-primary placeholder:text-text-tertiary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';
// appearance-none kills the browser's edge-pinned arrow; SelectShell paints
// the design's chevron at right:11px instead (.set-select / .set-select-chev).
const SELECT_CLASS =
  'w-full cursor-pointer appearance-none rounded-[9px] border border-border bg-surface-elevated py-[7px] pl-3 pr-8 font-mono text-[12.5px] font-semibold text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand-magenta),transparent_92%)]';

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

/** Read a string field off the open `ProviderDefaults` record, '' when absent/non-string. */
function readStr(rec: SafeConfig['assistants'][string] | undefined, key: string): string {
  const v = rec?.[key];
  return typeof v === 'string' ? v : '';
}

/** Seed editable form state from the saved config + the registered provider list. */
function seedForm(config: SafeConfig, providers: ProviderInfo[]): AssistantConfigForm {
  const models: Record<string, string> = {};
  for (const p of providers) models[p.id] = readStr(config.assistants[p.id], 'model');
  const codex = config.assistants.codex;
  return {
    assistant: config.assistant,
    models,
    modelReasoningEffort: readStr(codex, 'modelReasoningEffort'),
    webSearchMode: readStr(codex, 'webSearchMode'),
  };
}

/**
 * Editor for the global default assistant + per-provider model (and Codex
 * reasoning/web-search). Model is a FREE-TEXT input for every provider — Archon
 * does not validate model strings (the SDK is the source of truth and ships
 * models faster than we can enumerate them). Saves via PATCH /api/config/assistants
 * → ~/.archon/config.yaml, then invalidates K.config so the form re-seeds from the
 * persisted values (which also clears the dirty state).
 */
export function AssistantConfigPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);
  const { data: providers, error: providersError } = useEntity(K.providers, skill.listProviders);

  const [form, setForm] = useState<AssistantConfigForm | null>(null);
  const baselineRef = useRef('');
  useEffect(() => {
    if (config === undefined || providers === undefined) return;
    const seeded = seedForm(config.config, providers);
    setForm(seeded);
    baselineRef.current = JSON.stringify(seeded);
  }, [config, providers]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadError = configError ?? providersError;
  if (loadError !== undefined) {
    return (
      <SettingsSection title="Assistant">
        <p className="font-mono text-[11px] text-error">{loadError.message}</p>
      </SettingsSection>
    );
  }
  if (form === null || providers === undefined) {
    return (
      <SettingsSection title="Assistant">
        <p className="font-mono text-[11px] text-text-tertiary">Loading…</p>
      </SettingsSection>
    );
  }

  const dirty = JSON.stringify(form) !== baselineRef.current;

  const setModel = (id: string, value: string): void => {
    setForm(f => (f === null ? f : { ...f, models: { ...f.models, [id]: value } }));
  };
  const patch = (partial: Partial<AssistantConfigForm>): void => {
    setForm(f => (f === null ? f : { ...f, ...partial }));
  };

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      await skill.updateAssistantConfig(skill.buildAssistantUpdate(form));
      invalidate(K.config); // refetch re-seeds the form and clears `dirty`
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Assistant">
      <label className="mb-5 flex items-center gap-[18px]">
        <span className="w-[150px] shrink-0 text-[13.5px] font-semibold text-text-secondary">
          Default assistant
        </span>
        <SelectShell className="flex-1">
          <select
            value={form.assistant}
            onChange={e => {
              patch({ assistant: e.target.value });
            }}
            className={`${SELECT_CLASS} py-[11px] pl-3.5 text-[13.5px]`}
          >
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </SelectShell>
      </label>

      <div className="flex flex-col gap-[11px]">
        {providers.map(p => {
          const isDefault = p.id === form.assistant;
          return (
            <div
              key={p.id}
              className="flex items-start gap-[18px] rounded-xl border bg-surface-elevated p-4 transition-colors"
              // Active/default provider gets the magenta tint (design .set-provider.active).
              style={
                isDefault
                  ? {
                      borderColor: 'color-mix(in oklch, var(--brand-magenta), transparent 72%)',
                      background:
                        'linear-gradient(180deg, color-mix(in oklch, var(--brand-magenta), transparent 95%), transparent)',
                    }
                  : { borderColor: 'var(--border)' }
              }
            >
              <div className="flex w-[150px] shrink-0 flex-wrap items-center gap-2 pt-[11px] text-[13.5px] font-bold text-text-primary">
                {p.displayName}
                {isDefault ? (
                  <span
                    className="rounded-full border px-[7px] py-px font-mono text-[9.5px] font-bold uppercase tracking-[0.06em]"
                    style={{
                      color: 'var(--brand-magenta)',
                      background: 'color-mix(in oklch, var(--brand-magenta), transparent 88%)',
                      borderColor: 'color-mix(in oklch, var(--brand-magenta), transparent 70%)',
                    }}
                  >
                    Default
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <input
                  value={form.models[p.id] ?? ''}
                  onChange={e => {
                    setModel(p.id, e.target.value);
                  }}
                  placeholder="model (e.g. sonnet, gpt-5.3-codex) — blank = inherit"
                  className={INPUT_CLASS}
                />
                {p.id === 'codex' ? (
                  <div className="mt-[11px] flex flex-wrap items-center justify-end gap-5">
                    <label className="flex items-center gap-[9px] font-mono text-[12px] text-text-tertiary">
                      <span>effort</span>
                      <SelectShell>
                        <select
                          value={form.modelReasoningEffort}
                          onChange={e => {
                            patch({ modelReasoningEffort: e.target.value });
                          }}
                          className={SELECT_CLASS}
                        >
                          <option value="">inherit</option>
                          {REASONING_EFFORTS.map(o => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </SelectShell>
                    </label>
                    <label className="flex items-center gap-[9px] font-mono text-[12px] text-text-tertiary">
                      <span>web search</span>
                      <SelectShell>
                        <select
                          value={form.webSearchMode}
                          onChange={e => {
                            patch({ webSearchMode: e.target.value });
                          }}
                          className={SELECT_CLASS}
                        >
                          <option value="">inherit</option>
                          {WEB_SEARCH_MODES.map(o => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </SelectShell>
                    </label>
                  </div>
                ) : null}
              </div>
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
