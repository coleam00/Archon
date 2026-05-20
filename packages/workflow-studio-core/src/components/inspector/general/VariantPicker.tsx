import { useState, type CSSProperties, type ReactElement } from 'react';
import { useBuilderStore } from '../../../store/builder-store';
import { VARIANT_IDS, type VariantId } from '../../../nodes/registry';
import { VariantConvertConfirmModal } from './VariantConvertConfirmModal';

/**
 * Dropdown that shows the current node variant and lets the user convert to
 * a different variant via a confirmation modal. Reads primarySelectionId from
 * the builder store; renders nothing if no node is selected.
 */
export function VariantPicker(): ReactElement | null {
  const selectedId = useBuilderStore(s => s.primarySelectionId);
  const nodes = useBuilderStore(s => s.nodes);
  const convertVariant = useBuilderStore(s => s.convertVariant);

  const node = selectedId ? nodes.find(n => n.id === selectedId) : undefined;

  const [pendingVariant, setPendingVariant] = useState<VariantId | null>(null);

  if (!node || !selectedId) return null;

  const currentVariant = node.variant;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value as VariantId;
    if (next === currentVariant) return;
    setPendingVariant(next);
  };

  const handleConfirm = (): void => {
    if (pendingVariant) {
      convertVariant(selectedId, pendingVariant);
    }
    setPendingVariant(null);
  };

  const handleCancel = (): void => {
    setPendingVariant(null);
  };

  return (
    <>
      <div style={containerStyle}>
        <label htmlFor="variant-picker-select" style={labelStyle}>
          Variant
        </label>
        <select
          id="variant-picker-select"
          value={currentVariant}
          onChange={handleChange}
          style={selectStyle}
        >
          {VARIANT_IDS.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      {pendingVariant && (
        <VariantConvertConfirmModal
          fromVariant={currentVariant}
          toVariant={pendingVariant}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </>
  );
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 12px',
  borderBottom: '1px solid var(--studio-border)',
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--studio-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const selectStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  fontFamily: 'var(--studio-mono)',
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};
