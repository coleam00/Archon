import type { InspectorProps } from '../../../nodes/shared/types';
import { Field, JsonField } from '../shared';
import { inputStyle, selectStyle, textareaStyle } from '../../../nodes/shared/inspectorStyles';

const PROVIDERS = ['anthropic', 'openai', 'google', 'bedrock', 'vertex'] as const;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;

const linesToList = (s: string): string[] =>
  s
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

/**
 * Shared base-field tab. Renders the AI base fields exposed by
 * dagNodeBaseSchema (drift §3): provider, model, fallbackModel, systemPrompt,
 * effort, maxBudgetUsd, thinking (JSON), betas (line-per-row).
 *
 * Drift §3: the plan's `model_settings` is fictional. Each AI base field
 * here is an individual schema-typed field — they're routed by
 * `pickBaseFields` into `n.base`, not nested under a wrapper.
 */
export function ProviderTab({ base, onChange }: InspectorProps<unknown>): JSX.Element {
  return (
    <>
      <Field label="Provider" htmlFor="prov-select">
        <select
          id="prov-select"
          aria-label="Provider"
          value={(base.provider as string) ?? ''}
          onChange={e => {
            onChange({ provider: e.target.value || null });
          }}
          style={selectStyle}
        >
          <option value="">(inherit)</option>
          {PROVIDERS.map(p => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model" htmlFor="prov-model" hint="e.g., claude-opus-4-7, gpt-5.">
        <input
          id="prov-model"
          aria-label="Model"
          value={(base.model as string) ?? ''}
          onChange={e => {
            onChange({ model: e.target.value || null });
          }}
          style={inputStyle}
        />
      </Field>
      <Field
        label="Fallback model"
        htmlFor="prov-fallback"
        hint="Used when the primary model errors."
      >
        <input
          id="prov-fallback"
          aria-label="Fallback model"
          value={(base.fallbackModel as string) ?? ''}
          onChange={e => {
            onChange({ fallbackModel: e.target.value || null });
          }}
          style={inputStyle}
        />
      </Field>
      <Field
        label="System prompt"
        htmlFor="prov-system"
        hint="Prepended to the agent's system message for this step."
      >
        <textarea
          id="prov-system"
          aria-label="System prompt"
          value={(base.systemPrompt as string) ?? ''}
          onChange={e => {
            onChange({ systemPrompt: e.target.value || null });
          }}
          rows={3}
          style={textareaStyle}
        />
      </Field>
      <Field label="Effort" htmlFor="prov-effort">
        <select
          id="prov-effort"
          aria-label="Effort"
          value={(base.effort as string) ?? ''}
          onChange={e => {
            onChange({ effort: e.target.value || null });
          }}
          style={selectStyle}
        >
          <option value="">(inherit)</option>
          {EFFORT_LEVELS.map(l => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Max budget (USD)" htmlFor="prov-budget" hint="Empty = no per-step budget cap.">
        <input
          id="prov-budget"
          aria-label="Max budget"
          type="number"
          min={0}
          step={0.01}
          value={(base.maxBudgetUsd as number) ?? ''}
          onChange={e => {
            onChange({ maxBudgetUsd: e.target.value === '' ? null : Number(e.target.value) });
          }}
          style={inputStyle}
        />
      </Field>
      <JsonField
        label="Thinking"
        value={base.thinking ?? {}}
        onChange={v => {
          onChange({ thinking: v && Object.keys(v as object).length ? v : null });
        }}
        hint="ThinkingConfig: { type: 'adaptive' | 'enabled' | 'disabled', budgetTokens?: number }."
      />
      <Field
        label="Betas"
        htmlFor="prov-betas"
        hint="One header per line. Anthropic API beta flags."
      >
        <textarea
          id="prov-betas"
          aria-label="Betas"
          value={((base.betas as string[]) ?? []).join('\n')}
          onChange={e => {
            const list = linesToList(e.target.value);
            onChange({ betas: list.length ? list : null });
          }}
          rows={3}
          style={textareaStyle}
        />
      </Field>
    </>
  );
}
