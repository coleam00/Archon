import { useEffect, useRef, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import type {
  SafeConfig,
  PiModelInfo,
  ProviderInfo,
  ProviderKeyList,
  AssistantConfigForm,
  UserAiPrefs,
} from '../skills';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import { effortOptionsForAgent } from '../lib/model-options';
import { useCancelledRef } from '../lib/use-cancelled-ref';
import { errorDetail } from '../lib/http';
import { SettingsSection } from './SettingsSection';
import { SELECT_CLASS_COMPACT, SelectShell } from './SettingsFormPrimitives';
import { ModelPickerField } from './ModelPickerField';
import { UserPrefsLoadFailed, userScopeStatus } from './ScopeToggle';

const WEB_SEARCH_MODES = ['disabled', 'cached', 'live'] as const;

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
    assistant: config.assistant ?? '',
    models,
    modelReasoningEffort: readStr(codex, 'modelReasoningEffort'),
    webSearchMode: readStr(codex, 'webSearchMode'),
  };
}

/**
 * Editor for the global default assistant + per-provider model (and Codex
 * reasoning/web-search). The model field is agent-aware (ModelPickerField,
 * #1957) but never blocks free text — Archon does not validate model strings
 * (the SDK is the source of truth and ships models faster than we can
 * enumerate them). Saves via PATCH /api/config/assistants
 * → ~/.archon/config.yaml, then invalidates K.config so the form re-seeds from the
 * persisted values (which also clears the dirty state).
 */
export function AssistantConfigPanel(): ReactElement {
  const { data: config, error: configError } = useEntity(K.config, skill.getConfig);
  const { data: providers, error: providersError } = useEntity(K.providers, skill.listProviders);
  // Per-user default assistant (Phase 3): a "Just me" select that overrides the
  // install default for runs/chats this user starts. Hidden on a 401 (no web
  // identity — solo-PAT or logged out); any other prefs read failure is shown.
  const { data: userPrefs, error: userPrefsError } = useEntity<UserAiPrefs>(
    K.userAiPrefs,
    skill.getUserAiPrefs
  );
  // Agents matrix + Pi catalog for the agent-aware model pickers (#1957).
  // Both share cache keys with other Settings panels (one fetch per page);
  // undefined (401/error) just means pickers render without readiness data.
  const { data: keyData } = useEntity<ProviderKeyList>(
    K.providerConnections,
    skill.listProviderKeys
  );
  const { data: piModels } = useEntity<PiModelInfo[]>(K.piModels, skill.listPiModels);
  const userScope = userScopeStatus(userPrefsError);
  const [savingUserDefault, setSavingUserDefault] = useState(false);
  const [userDefaultError, setUserDefaultError] = useState<string | null>(null);

  // Guard async setState after unmount (same hook as the sibling panels).
  const cancelledRef = useCancelledRef();

  // "Just me" chat default: provider + optional model pin (#1998), edited as a
  // draft and saved atomically (the server clears any model pin not sent with
  // the provider, so a stale pin can never ride a provider switch).
  const [userDraft, setUserDraft] = useState<{ provider: string; model: string } | null>(null);
  const userBaselineRef = useRef('');
  useEffect(() => {
    if (userPrefs === undefined) return;
    const seeded = {
      provider: userPrefs.defaultProvider ?? '',
      model: userPrefs.defaultModel ?? '',
    };
    setUserDraft(seeded);
    userBaselineRef.current = JSON.stringify(seeded);
  }, [userPrefs]);
  const userDirty = userDraft !== null && JSON.stringify(userDraft) !== userBaselineRef.current;

  const onUserDefaultSave = async (): Promise<void> => {
    if (userDraft === null) return;
    setSavingUserDefault(true);
    setUserDefaultError(null);
    try {
      await skill.updateUserDefault(
        userDraft.provider === '' ? null : userDraft.provider,
        userDraft.provider === '' || userDraft.model === '' ? null : userDraft.model
      );
      if (cancelledRef.current) return;
      invalidate(K.userAiPrefs); // refetch re-seeds the draft and clears dirty
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      setUserDefaultError(e instanceof Error ? e.message : 'Failed to save your default.');
    } finally {
      if (!cancelledRef.current) setSavingUserDefault(false);
    }
  };

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
      <SettingsSection title="Defaults">
        <p className="font-mono text-console-11 text-error">{loadError.message}</p>
      </SettingsSection>
    );
  }
  if (form === null || providers === undefined) {
    return (
      <SettingsSection title="Defaults">
        <p className="font-mono text-console-11 text-text-tertiary">Loading…</p>
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
      setSaveError(e instanceof Error ? errorDetail(e) : 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const renderUserDefault = (): ReactElement => (
    <>
      {userScope.kind === 'load-failed' ? (
        <div className="mb-5">
          <UserPrefsLoadFailed error={userScope.error} />
        </div>
      ) : null}
      {userScope.kind === 'available' && userDraft !== null ? (
        <div className="mb-5 flex flex-wrap items-center gap-4.5">
          <span className="w-37.5 shrink-0 text-console-14 font-semibold text-text-secondary">
            Chat runs on{' '}
            <span className="font-mono text-console-10 font-bold uppercase tracking-wider text-text-tertiary">
              just me
            </span>
          </span>
          <SelectShell className="w-45 shrink-0">
            <select
              value={userDraft.provider}
              onChange={e => {
                // Model pin belongs to the provider it was set with — clear it
                // on a switch (mirrors the atomic server write).
                const provider = e.target.value;
                setUserDraft({ provider, model: '' });
              }}
              disabled={savingUserDefault}
              aria-label="Your default assistant"
              className={`${SELECT_CLASS_COMPACT} py-2.75 pl-3.5 text-console-14`}
            >
              <option value="">Inherit (this install)</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </SelectShell>
          <ModelPickerField
            key={userDraft.provider}
            agentId={userDraft.provider}
            value={userDraft.model}
            onChange={v => {
              setUserDraft(d => (d === null ? d : { ...d, model: v }));
            }}
            disabled={savingUserDefault || userDraft.provider === ''}
            placeholder={
              userDraft.provider === '' ? 'inherit (this install)' : 'model — blank = tier default'
            }
            selectEmptyLabel="tier default"
            ariaLabel="Your default chat model"
            className="min-w-40 flex-1"
            agents={keyData?.agents}
            piModels={piModels}
          />
          {userDirty ? (
            <button
              type="button"
              onClick={() => void onUserDefaultSave()}
              disabled={savingUserDefault}
              className="rounded-lg border border-border px-3.5 py-2 text-console-13 font-bold text-text-primary transition-colors hover:bg-surface-elevated disabled:opacity-40"
            >
              {savingUserDefault ? 'Saving…' : 'Save'}
            </button>
          ) : null}
          {userDefaultError !== null ? (
            <span className="font-mono text-console-11 text-error">{userDefaultError}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );

  return (
    <SettingsSection title="Defaults">
      {/* Lead combo (#1998): "chat runs on [provider][model]" — the install
          row edits the default assistant + its default model
          (assistants.<p>.model, shared state with the grid row below); saved
          by the panel's Save button. */}
      <label className="mb-5 flex flex-wrap items-center gap-4.5">
        <span className="w-37.5 shrink-0 text-console-14 font-semibold text-text-secondary">
          Chat runs on{' '}
          <span className="font-mono text-console-10 font-bold uppercase tracking-wider text-text-tertiary">
            this install
          </span>
        </span>
        <SelectShell className="w-45 shrink-0">
          <select
            value={form.assistant}
            onChange={e => {
              patch({ assistant: e.target.value });
            }}
            className={`${SELECT_CLASS_COMPACT} py-2.75 pl-3.5 text-console-14`}
          >
            {form.assistant === '' && (
              <option value="" disabled>
                Select a default provider
              </option>
            )}
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </SelectShell>
        {form.assistant !== '' && (
          <ModelPickerField
            // Re-key per agent so picker-internal state never bleeds across a switch.
            key={form.assistant}
            agentId={form.assistant}
            value={form.models[form.assistant] ?? ''}
            onChange={v => {
              setModel(form.assistant, v);
            }}
            placeholder="model — blank = tier default"
            selectEmptyLabel="tier default"
            ariaLabel="Install default chat model"
            className="min-w-40 flex-1"
            agents={keyData?.agents}
            piModels={piModels}
          />
        )}
      </label>

      {renderUserDefault()}

      <div className="flex flex-col gap-2.75">
        {providers.map(p => {
          const isDefault = p.id === form.assistant;
          return (
            <div
              key={p.id}
              className="flex items-start gap-4.5 rounded-xl border bg-surface-elevated p-4 transition-colors"
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
              <div className="flex w-37.5 shrink-0 flex-wrap items-center gap-2 pt-2.75 text-console-14 font-bold text-text-primary">
                {p.displayName}
                {isDefault ? (
                  <span
                    className="rounded-full border px-1.75 py-px font-mono text-console-10 font-bold uppercase tracking-wider"
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
                <ModelPickerField
                  agentId={p.id}
                  value={form.models[p.id] ?? ''}
                  onChange={v => {
                    setModel(p.id, v);
                  }}
                  placeholder="model (e.g. sonnet, gpt-6.1-sol) — blank = inherit"
                  selectEmptyLabel="inherit"
                  ariaLabel={`${p.displayName} default model`}
                  className="w-full"
                  agents={keyData?.agents}
                  piModels={piModels}
                />
                {p.id === 'codex' ? (
                  <div className="mt-2.75 flex flex-wrap items-center justify-end gap-5">
                    <label className="flex items-center gap-2.25 font-mono text-console-12 text-text-tertiary">
                      <span>effort</span>
                      <SelectShell>
                        <select
                          value={form.modelReasoningEffort}
                          onChange={e => {
                            patch({ modelReasoningEffort: e.target.value });
                          }}
                          className={SELECT_CLASS_COMPACT}
                        >
                          <option value="">inherit</option>
                          {effortOptionsForAgent('codex', providers)?.map(o => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </SelectShell>
                    </label>
                    <label className="flex items-center gap-2.25 font-mono text-console-12 text-text-tertiary">
                      <span>web search</span>
                      <SelectShell>
                        <select
                          value={form.webSearchMode}
                          onChange={e => {
                            patch({ webSearchMode: e.target.value });
                          }}
                          className={SELECT_CLASS_COMPACT}
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

      <div className="mt-4.5 flex items-center justify-end gap-3">
        {saveError !== null ? (
          <span className="font-mono text-console-11 text-error">{saveError}</span>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!dirty || saving}
          className="brand-bar rounded-lg px-4.5 py-2.5 text-console-13 font-bold text-white shadow-[0_8px_22px_-10px_color-mix(in_oklch,var(--brand-magenta),transparent_20%)] transition-all hover:-translate-y-px hover:brightness-110 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </SettingsSection>
  );
}
