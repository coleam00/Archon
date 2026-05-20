import type { CSSProperties } from 'react';

/** Shared form-control styles used by every per-variant Inspector body. */

export const inputStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};

export const textareaStyle: CSSProperties = {
  padding: 8,
  fontSize: 13,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
  resize: 'vertical',
};

export const monoTextareaStyle: CSSProperties = {
  ...textareaStyle,
  fontFamily: 'var(--studio-mono)',
  fontSize: 12,
};

export const selectStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
