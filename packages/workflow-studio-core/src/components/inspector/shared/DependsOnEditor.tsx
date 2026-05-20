import { useState, useMemo, type CSSProperties } from 'react';
import { Field } from './Field';

interface Props {
  value: string[];
  siblingIds: string[];
  onChange: (next: string[]) => void;
}

/**
 * Chip-list editor for `depends_on`. Each existing dependency is a removable
 * chip; new ids are added by typing and pressing Enter, autocompleted from
 * `siblingIds`. Unknown ids (typed text not in siblingIds) surface an error
 * and are NOT added — backstop for the off-screen-parents UX from spec §7.4.
 */
export function DependsOnEditor({ value, siblingIds, onChange }: Props): JSX.Element {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();

  const candidates = useMemo(
    () => siblingIds.filter(s => !value.includes(s) && (draft === '' || s.startsWith(draft))),
    [siblingIds, value, draft]
  );

  const remove = (id: string): void => {
    onChange(value.filter(v => v !== id));
  };

  const add = (): void => {
    const next = draft.trim();
    if (!next) return;
    const exact = siblingIds.find(s => s === next);
    const match = exact ?? candidates[0];
    if (!match || (next !== match && !match.startsWith(next))) {
      setError(`Unknown id '${next}'.`);
      return;
    }
    if (value.includes(match)) {
      setDraft('');
      return;
    }
    onChange([...value, match]);
    setDraft('');
    setError(undefined);
  };

  return (
    <Field
      label="Depends on"
      hint="Type or pick parent node ids. Useful for off-screen dependencies."
      error={error}
    >
      <div style={chipRowStyle}>
        {value.map(id => (
          <span key={id} style={chipStyle}>
            {id}
            <button
              type="button"
              aria-label={`Remove ${id}`}
              onClick={() => {
                remove(id);
              }}
              style={chipRemoveStyle}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label="Add dependency"
          list={`deps-${siblingIds.length}`}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            setError(undefined);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="add…"
          style={inputStyle}
        />
        <datalist id={`deps-${siblingIds.length}`}>
          {candidates.map(c => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
    </Field>
  );
}

const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  alignItems: 'center',
};
const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 6px',
  fontSize: 12,
  background: 'var(--studio-bg-elevated)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
const chipRemoveStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--studio-muted)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};
const inputStyle: CSSProperties = {
  flex: '1 1 80px',
  minWidth: 80,
  padding: '4px 6px',
  fontSize: 12,
  background: 'transparent',
  color: 'var(--studio-fg)',
  border: 'none',
  outline: 'none',
};
