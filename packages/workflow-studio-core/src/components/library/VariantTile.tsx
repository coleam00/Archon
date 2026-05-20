import type { VariantId } from '../../nodes/registry';
import type { VariantLibraryMetadata } from '../../nodes/shared/types';

export interface VariantTileProps {
  id: VariantId;
  meta: VariantLibraryMetadata;
  onActivate: () => void;
  /** Drag wiring — Task 47 supplies these props; click-only mode passes nothing. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

export function VariantTile({
  id,
  meta,
  onActivate,
  draggable,
  onDragStart,
}: VariantTileProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Add ${id} node`}
      onClick={onActivate}
      draggable={draggable}
      onDragStart={onDragStart}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        textAlign: 'left',
        background: 'var(--studio-surface)',
        color: 'var(--studio-fg)',
        border: '1px solid var(--studio-muted)',
        borderRadius: 'var(--radius-sm)',
        cursor: draggable ? 'grab' : 'pointer',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 4,
          height: 28,
          borderRadius: 2,
          background: `var(--node-${id})`,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{meta.label}</div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--studio-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {meta.description}
        </div>
      </span>
    </button>
  );
}
