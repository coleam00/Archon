import type { CSSProperties } from 'react';
import type { VariantId } from '../../../nodes/registry';

interface VariantConvertConfirmModalProps {
  fromVariant: VariantId;
  toVariant: VariantId;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation modal shown before converting a node to a different variant.
 * Warns that variant-specific data may be lost.
 */
export function VariantConvertConfirmModal({
  fromVariant,
  toVariant,
  onConfirm,
  onCancel,
}: VariantConvertConfirmModalProps): JSX.Element {
  return (
    <div style={overlayStyle}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="variant-convert-title"
        style={dialogStyle}
      >
        <h2 id="variant-convert-title" style={titleStyle}>
          Convert variant?
        </h2>
        <p style={bodyStyle}>
          Converting from <strong>{fromVariant}</strong> to <strong>{toVariant}</strong> will
          reclassify node data. Variant-specific fields that the target variant does not recognise
          will be parked and may not be recoverable.
        </p>
        <div style={footerStyle}>
          <button type="button" onClick={onCancel} style={cancelBtnStyle}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} style={confirmBtnStyle}>
            Convert
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const dialogStyle: CSSProperties = {
  background: 'var(--studio-bg, #1e1e2e)',
  color: 'var(--studio-fg, #cdd6f4)',
  border: '1px solid var(--studio-border, #45475a)',
  borderRadius: 8,
  padding: 24,
  width: 340,
  maxWidth: '90vw',
};

const titleStyle: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 15,
  fontWeight: 600,
};

const bodyStyle: CSSProperties = {
  margin: '0 0 20px',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--studio-muted, #a6adc8)',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const cancelBtnStyle: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  background: 'transparent',
  color: 'var(--studio-fg, #cdd6f4)',
  border: '1px solid var(--studio-border, #45475a)',
  borderRadius: 4,
  cursor: 'pointer',
};

const confirmBtnStyle: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  background: 'var(--studio-accent, #89b4fa)',
  color: 'var(--studio-bg, #1e1e2e)',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 600,
};
