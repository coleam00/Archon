import type { CSSProperties } from 'react';
import type { AtomNode, DnfAst } from '../../lib/grammar';
import { AtomRow } from './AtomRow';

interface Props {
  dnf: DnfAst;
  upstreamIds: readonly string[];
  outputFormatLookup: (nodeId: string) => Record<string, unknown> | null;
  onChange: (next: DnfAst) => void;
}

const emptyAtom = (firstUpstream: string | undefined): AtomNode => ({
  kind: 'atom',
  ref: { nodeId: firstUpstream ?? '', path: ['output'] },
  op: '==',
  value: '',
});

export function WhenBuilder({
  dnf,
  upstreamIds,
  outputFormatLookup,
  onChange,
}: Props): JSX.Element {
  return (
    <div data-testid="when-builder">
      {dnf.children.map((group, gi) => (
        <div key={gi}>
          <div style={andBoxStyle}>
            <header style={andHeaderStyle}>all of</header>
            {group.children.map((atom, ai) => (
              <AtomRow
                key={ai}
                atom={atom}
                upstreamIds={upstreamIds}
                outputFormatLookup={outputFormatLookup}
                onChange={nextAtom => {
                  const nextGroup = {
                    ...group,
                    children: group.children.map((a, i) => (i === ai ? nextAtom : a)),
                  };
                  onChange({
                    ...dnf,
                    children: dnf.children.map((g, i) => (i === gi ? nextGroup : g)),
                  });
                }}
                onRemove={() => {
                  const nextChildren = group.children.filter((_, i) => i !== ai);
                  if (nextChildren.length === 0) {
                    onChange({
                      ...dnf,
                      children: dnf.children.filter((_, i) => i !== gi),
                    });
                  } else {
                    onChange({
                      ...dnf,
                      children: dnf.children.map((g, i) =>
                        i === gi ? { ...g, children: nextChildren } : g
                      ),
                    });
                  }
                }}
              />
            ))}
            <button
              type="button"
              style={addRowStyle}
              onClick={() => {
                onChange({
                  ...dnf,
                  children: dnf.children.map((g, i) =>
                    i === gi ? { ...g, children: [...g.children, emptyAtom(upstreamIds[0])] } : g
                  ),
                });
              }}
            >
              + AND row
            </button>
          </div>
          {gi < dnf.children.length - 1 && <div style={orLabelStyle}>OR</div>}
        </div>
      ))}
      <button
        type="button"
        style={addGroupStyle}
        onClick={() => {
          onChange({
            ...dnf,
            children: [...dnf.children, { kind: 'and', children: [emptyAtom(upstreamIds[0])] }],
          });
        }}
      >
        + OR group
      </button>
    </div>
  );
}

const andBoxStyle: CSSProperties = {
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  padding: 8,
  background: 'var(--studio-bg)',
};
const andHeaderStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--studio-fg-muted)',
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const orLabelStyle: CSSProperties = {
  textAlign: 'center',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--studio-fg-muted)',
  margin: '6px 0',
};
const addRowStyle: CSSProperties = {
  background: 'transparent',
  border: '1px dashed var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 8px',
  fontSize: 12,
  color: 'var(--studio-fg-muted)',
  cursor: 'pointer',
  marginTop: 4,
};
const addGroupStyle: CSSProperties = { ...addRowStyle, marginTop: 8 };
