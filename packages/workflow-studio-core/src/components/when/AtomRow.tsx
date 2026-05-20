import type { CSSProperties } from 'react';
import type { AtomNode, WhenOp } from '../../lib/grammar';

interface Props {
  atom: AtomNode;
  upstreamIds: readonly string[];
  outputFormatLookup: (nodeId: string) => Record<string, unknown> | null;
  onChange: (next: AtomNode) => void;
  onRemove: () => void;
}

const OPS: WhenOp[] = ['==', '!=', '<', '>', '<=', '>='];

export function AtomRow({
  atom,
  upstreamIds,
  outputFormatLookup,
  onChange,
  onRemove,
}: Props): JSX.Element {
  const fmt = outputFormatLookup(atom.ref.nodeId);
  const fields = Object.keys((fmt?.properties as Record<string, unknown> | undefined) ?? {});
  const fieldKey = atom.ref.path.length > 1 ? atom.ref.path[1] : '';

  return (
    <div style={rowStyle} data-testid="atom-row">
      <select
        aria-label="Node"
        value={atom.ref.nodeId}
        onChange={e => {
          onChange({ ...atom, ref: { nodeId: e.target.value, path: ['output'] } });
        }}
        style={selectStyle}
      >
        {/* If atom.ref.nodeId isn't in upstreamIds (e.g., dangling ref), show it. */}
        {!upstreamIds.includes(atom.ref.nodeId) && atom.ref.nodeId && (
          <option value={atom.ref.nodeId}>{`$${atom.ref.nodeId} (dangling)`}</option>
        )}
        {upstreamIds.map(id => (
          <option key={id} value={id}>{`$${id}`}</option>
        ))}
      </select>
      <span style={{ opacity: 0.5 }}>.output.</span>
      <select
        aria-label="Field"
        value={fieldKey}
        onChange={e => {
          onChange({
            ...atom,
            ref: {
              nodeId: atom.ref.nodeId,
              path: e.target.value ? ['output', e.target.value] : ['output'],
            },
          });
        }}
        style={selectStyle}
      >
        <option value="">(none)</option>
        {fields.map(f => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        {/* If current field isn't in the schema (custom output_format or dangling), show it. */}
        {fieldKey && !fields.includes(fieldKey) && (
          <option value={fieldKey}>{`${fieldKey} (custom)`}</option>
        )}
      </select>
      <select
        aria-label="Operator"
        value={atom.op}
        onChange={e => {
          onChange({ ...atom, op: e.target.value as WhenOp });
        }}
        style={selectStyle}
      >
        {OPS.map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        aria-label="Value"
        type="text"
        value={atom.value}
        onChange={e => {
          onChange({ ...atom, value: e.target.value });
        }}
        style={inputStyle}
      />
      <button type="button" onClick={onRemove} aria-label="Remove atom" style={removeStyle}>
        ×
      </button>
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  alignItems: 'center',
  marginBottom: 4,
};
const selectStyle: CSSProperties = {
  padding: '4px 6px',
  fontSize: 12,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
const inputStyle: CSSProperties = { ...selectStyle, flex: 1, minWidth: 80 };
const removeStyle: CSSProperties = {
  ...selectStyle,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--studio-fg-muted)',
};
