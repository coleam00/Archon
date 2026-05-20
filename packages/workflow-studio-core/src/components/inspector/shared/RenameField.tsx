import { useState, useEffect, type CSSProperties } from 'react';
import { useBuilderStore } from '../../../store/builder-store';
import { Field } from './Field';

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

interface RenameFieldProps {
  id: string;
}

/**
 * Inline editor for the node's id. On commit (blur or Enter) calls
 * `store.renameNode`, which cascades through depends_on, when:, and body
 * references in prompt/bash/script/loop.prompt/approval.message. Validates
 * locally for collision and id-pattern before dispatching, so the store
 * never has to throw when the inspector is the caller.
 */
export function RenameField({ id }: RenameFieldProps): JSX.Element {
  const [draft, setDraft] = useState(id);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setDraft(id);
    setError(undefined);
  }, [id]);

  const commit = (): void => {
    const next = draft.trim();
    if (next === id) return;
    if (!ID_PATTERN.test(next)) {
      setError('Invalid id — must start with a letter; letters / digits / `_` / `-` only.');
      setDraft(id);
      return;
    }
    const exists = useBuilderStore.getState().nodes.some(n => n.id === next);
    if (exists) {
      setError(`Id '${next}' already exists.`);
      setDraft(id);
      return;
    }
    try {
      useBuilderStore.getState().renameNode(id, next);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
      setDraft(id);
    }
  };

  return (
    <Field
      label="Node ID"
      htmlFor={`rename-${id}`}
      hint="Renames cascade through depends_on, when:, and $id.output references."
      error={error}
    >
      <input
        id={`rename-${id}`}
        aria-label="Node ID"
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={inputStyle}
      />
    </Field>
  );
}

const inputStyle: CSSProperties = {
  padding: '6px 8px',
  fontFamily: 'var(--studio-mono)',
  fontSize: 13,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
