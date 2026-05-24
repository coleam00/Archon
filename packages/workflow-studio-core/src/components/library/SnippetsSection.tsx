import type { CSSProperties } from 'react';
import { SNIPPET_STARTERS, SNIPPET_PATTERNS, loadSnippet } from '../../snippets';
import { CollapsibleSection } from './CollapsibleSection';
import { LIBRARY_DRAG_MIME, encodeLibraryDrag } from './dragPayload';
import { insertSnippet } from '../../snippets/insertSnippet';
import { usePositionContext } from '../../hooks/PositionContext';
import { useUserLibraryStore, type UserSnippet } from '../../store/user-library-store';

export function SnippetsSection(): JSX.Element {
  const { setPosition } = usePositionContext();
  // Subscribe to the user-library store so newly-saved snippets appear here
  // without a page reload. The store is module-load-hydrated from localStorage,
  // so the value is correct on first render.
  const userSnippets = useUserLibraryStore(s => s.userSnippets);
  const removeUserSnippet = useUserLibraryStore(s => s.removeUserSnippet);

  const insertAtOrigin = (category: 'starters' | 'patterns', name: string): void => {
    insertSnippet({
      yaml: loadSnippet(category, name),
      anchorPosition: { x: 0, y: 0 },
      setPosition,
    });
  };

  const insertUserAtOrigin = (snippet: UserSnippet): void => {
    insertSnippet({
      yaml: snippet.yaml,
      anchorPosition: { x: 0, y: 0 },
      setPosition,
    });
  };

  return (
    <CollapsibleSection id="snippets" title="Snippets" bordered={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {userSnippets.length > 0 ? (
          <UserSnippetGroup
            label="Your snippets"
            snippets={userSnippets}
            onActivate={insertUserAtOrigin}
            onRemove={removeUserSnippet}
          />
        ) : null}
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
    </CollapsibleSection>
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
      <ul style={listStyle}>
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

function UserSnippetGroup({
  label,
  snippets,
  onActivate,
  onRemove,
}: {
  label: string;
  snippets: readonly UserSnippet[];
  onActivate: (snippet: UserSnippet) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  return (
    <div>
      <div style={subheadingStyle}>{label}</div>
      <ul style={listStyle}>
        {snippets.map(snippet => (
          <li key={snippet.id} style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
            <button
              type="button"
              aria-label={`Insert snippet ${snippet.name}`}
              draggable
              onDragStart={e => {
                // user-snippet payloads embed the YAML directly because user
                // snippets live in localStorage, not in the bundled fixtures
                // map. See dragPayload.ts for the union shape.
                e.dataTransfer.setData(
                  LIBRARY_DRAG_MIME,
                  encodeLibraryDrag({
                    kind: 'user-snippet',
                    name: snippet.name,
                    yaml: snippet.yaml,
                  })
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => {
                onActivate(snippet);
              }}
              style={{ ...rowStyle, flex: 1 }}
            >
              {snippet.name}
            </button>
            <button
              type="button"
              aria-label={`Delete snippet ${snippet.name}`}
              title="Delete snippet"
              onClick={() => {
                onRemove(snippet.id);
              }}
              style={removeButtonStyle}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const subheadingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--studio-fg)',
  marginBottom: 4,
};
const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
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
const removeButtonStyle: CSSProperties = {
  flexShrink: 0,
  width: 24,
  background: 'transparent',
  color: 'var(--studio-muted)',
  border: '1px solid transparent',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
};
