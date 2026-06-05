import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type { SafeConfig, ProviderInfo, AssistantConfigForm } from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { SettingsSection } from './SettingsSection';

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const WEB_SEARCH_MODES = ['disabled', 'cached', 'live'] as const;

const INPUT_CLASS =
  'w-full rounded border border-border bg-surface px-2 py-1 font-mono text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none';
const SELECT_CLASS =
  'rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text-primary focus:border-border-bright focus:outline-none';

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
      <label className="mb-4 flex items-center gap-3 text-[12px]">
        <span className="w-32 shrink-0 text-text-secondary">Default assistant</span>
        <select
          value={form.assistant}
          onChange={e => {
            patch({ assistant: e.target.value });
          }}
          className={INPUT_CLASS}
        >
          {providers.map(p => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-3">
        {providers.map(p => (
          <div key={p.id} className="flex flex-col gap-2 rounded border border-border/60 p-3">
            <div className="flex items-center gap-3 text-[12px]">
              <span className="w-32 shrink-0 font-medium text-text-primary">{p.displayName}</span>
              <input
                value={form.models[p.id] ?? ''}
                onChange={e => {
                  setModel(p.id, e.target.value);
                }}
                placeholder="model (e.g. sonnet, gpt-5.3-codex) — blank = inherit"
                className={INPUT_CLASS}
              />
            </div>
            {p.id === 'codex' ? (
              <div className="flex flex-wrap items-center gap-3 pl-[8.75rem] text-[12px]">
                <label className="flex items-center gap-2">
                  <span className="text-text-tertiary">effort</span>
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
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-text-tertiary">web search</span>
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
                </label>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-3">
        {saveError !== null ? (
          <span className="font-mono text-[11px] text-error">{saveError}</span>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || saving}
          className="brand-bar rounded px-3 py-0.5 text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </SettingsSection>
  );
}
