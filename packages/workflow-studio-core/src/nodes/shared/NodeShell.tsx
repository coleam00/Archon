import { Handle, Position } from '@xyflow/react';
import type { ReactNode } from 'react';
import type { VariantId } from '../registry';
import styles from './NodeShell.module.css';

export interface NodeShellProps {
  variant: VariantId;
  label: string;
  selected: boolean;
  /** Top-right pill (e.g., "cap 5", "interactive", "fail-fast"). */
  badge?: ReactNode;
  /** Single line of secondary text under the label (truncated). */
  secondary?: ReactNode;
}

export function NodeShell({
  variant,
  label,
  selected,
  badge,
  secondary,
}: NodeShellProps): JSX.Element {
  return (
    <div
      className={styles.node}
      data-selected={selected ? 'true' : 'false'}
      data-variant={variant}
      style={{ width: 180, height: 80 }}
    >
      <div
        className={styles.stripe}
        data-stripe="true"
        style={{ background: `var(--node-${variant})` }}
      />
      <div className={styles.body}>
        <div className={styles.headerRow}>
          <div className={styles.label}>{label}</div>
          {badge !== undefined && <div className={styles.badge}>{badge}</div>}
        </div>
        {secondary !== undefined && <div className={styles.secondary}>{secondary}</div>}
        {badge === undefined && <div className={styles.tag}>{variant}</div>}
      </div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
