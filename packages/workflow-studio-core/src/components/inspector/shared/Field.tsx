import type { CSSProperties, ReactNode } from 'react';

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/**
 * Labelled form-field wrapper used by every Inspector tab. Renders a small
 * uppercase label, the input the caller supplies, and either a hint (when
 * idle) or an error (when present, takes precedence over the hint).
 */
export function Field({ label, htmlFor, hint, error, children }: FieldProps): JSX.Element {
  return (
    <div style={wrapStyle}>
      <label htmlFor={htmlFor} style={labelStyle}>
        {label}
      </label>
      {children}
      {hint && !error && <span style={hintStyle}>{hint}</span>}
      {error && (
        <span style={errorStyle} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
};
const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--studio-muted)',
};
const hintStyle: CSSProperties = { fontSize: 11, color: 'var(--studio-muted)' };
const errorStyle: CSSProperties = { fontSize: 11, color: 'var(--studio-danger, #ef4444)' };
