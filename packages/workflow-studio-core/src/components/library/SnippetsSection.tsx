import type { CSSProperties } from 'react';
import { SNIPPET_STARTERS, SNIPPET_PATTERNS, loadSnippet } from '../../snippets';
import { LIBRARY_DRAG_MIME, encodeLibraryDrag } from './dragPayload';
import { insertSnippet } from '../../snippets/insertSnippet';
import { usePositionContext } from '../../hooks/PositionContext';

export function SnippetsSection(): JSX.Element {
  const { setPosition } = usePositionContext();

  const insertAtOrigin = (category: 'starters' | 'patterns', name: string): void => {
    insertSnippet({
      yaml: loadSnippet(category, name),
      anchorPosition: { x: 0, y: 0 },
      setPosition,
    });
  };

  return (
    <section style={{ padding: 12 }}>
      <h3 style={headingStyle}>Snippets</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SnippetGroup
          label="Starters"
          category="starters"
          names={SNIPPET_STARTERS}
          onActivate={insertAtOrigin}
        />
        <SnippetGroup
          label="Patterns"
          category="patterns"
          names={SNIPPET_PATTERNS}
          onActivate={insertAtOrigin}
        />
      </div>
    </section>
  );
}

function SnippetGroup({
  label,
  category,
  names,
  onActivate,
}: {
  label: string;
  category: 'starters' | 'patterns';
  names: readonly string[];
  onActivate: (category: 'starters' | 'patterns', name: string) => void;
}): JSX.Element {
  return (
    <div>
      <div style={subheadingStyle}>{label}</div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {names.map(name => (
          <li key={name}>
            <button
              type="button"
              aria-label={`Insert snippet ${name}`}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData(
                  LIBRARY_DRAG_MIME,
                  encodeLibraryDrag({ kind: 'snippet', category, name })
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => {
                onActivate(category, name);
              }}
              style={rowStyle}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const headingStyle: CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--studio-muted)',
  margin: '0 0 8px 0',
};
const subheadingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--studio-fg)',
  marginBottom: 4,
};
const rowStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 8px',
  fontSize: 13,
  background: 'transparent',
  color: 'var(--studio-fg)',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm)',
  cursor: 'grab',
};
