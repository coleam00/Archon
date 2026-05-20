import { useState, useEffect, type CSSProperties } from 'react';
import { Field } from './Field';

interface Props {
  label: string;
  value: unknown;
  onChange: (next: unknown) => void;
  hint?: string;
}

/**
 * Free-form JSON editor with parse-error UI. Used by ProviderTab
 * (model_settings as raw JSON), ToolsTab (output_format), and AdvancedTab
 * (raw _unknown editor). Only emits `onChange` when the textarea contents
 * parse — invalid JSON shows the error and leaves the field uncommitted so
 * the user can fix it before re-blurring.
 */
export function JsonField({ label, value, onChange, hint }: Props): JSX.Element {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(JSON.stringify(value ?? {}, null, 2));
    setError(undefined);
  }, [value]);

  const commit = (): void => {
    try {
      const parsed = JSON.parse(draft);
      setError(undefined);
      onChange(parsed);
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  return (
    <Field label={label} hint={hint} error={error}>
      <textarea
        aria-label={label}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        rows={Math.min(12, draft.split('\n').length + 1)}
        style={textareaStyle}
      />
    </Field>
  );
}

const textareaStyle: CSSProperties = {
  fontFamily: 'var(--studio-mono)',
  fontSize: 12,
  padding: 8,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  resize: 'vertical',
};
