import { useMemo, useState, type ReactElement } from 'react';
import type { Issue, Severity } from '../validation/types';
import styles from './ValidationPanel.module.css';

export interface ValidationPanelProps {
  issues: readonly Issue[];
  expanded: boolean;
  onToggle: (next: boolean) => void;
  onFocusIssue: (issue: Issue) => void;
  isValidating?: boolean;
  /** Timestamp of the last completed validation run; 0 means never run. */
  lastRunAt?: number;
}

type SeverityFilter = 'all' | Severity;
type SourceFilter = 'all' | 'client' | 'server';

export function ValidationPanel({
  issues,
  expanded,
  onToggle,
  onFocusIssue,
  isValidating,
  lastRunAt = 0,
}: ValidationPanelProps): JSX.Element {
  const [sev, setSev] = useState<SeverityFilter>('all');
  const [src, setSrc] = useState<SourceFilter>('all');

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const i of issues) c[i.severity] += 1;
    return c;
  }, [issues]);

  const filtered = useMemo(() => {
    return issues.filter(i => {
      if (sev !== 'all' && i.severity !== sev) return false;
      if (src === 'client' && i.source === 'server') return false;
      if (src === 'server' && i.source !== 'server') return false;
      return true;
    });
  }, [issues, sev, src]);

  return (
    <div className={styles.root} aria-live="polite">
      <button
        type="button"
        className={styles.bar}
        onClick={() => {
          onToggle(!expanded);
        }}
        aria-label={expanded ? 'collapse validation panel' : 'expand validation panel'}
      >
        <Pill severity="error" count={counts.error} />
        <Pill severity="warning" count={counts.warning} />
        <Pill severity="info" count={counts.info} />
        {!isValidating && lastRunAt > 0 && issues.length === 0 ? (
          <span className={`${styles.pill} ${styles.pill_valid}`}>● Valid</span>
        ) : null}
        {isValidating ? <span className={styles.spinner} aria-hidden /> : null}
        <span className={styles.chev}>{expanded ? '▾' : '▴'}</span>
      </button>
      {expanded ? (
        <div className={styles.body}>
          <div className={styles.filters}>
            <Chip
              active={sev === 'all'}
              onClick={() => {
                setSev('all');
              }}
            >
              All
            </Chip>
            <Chip
              active={sev === 'error'}
              onClick={() => {
                setSev('error');
              }}
            >
              Errors only
            </Chip>
            <Chip
              active={sev === 'warning'}
              onClick={() => {
                setSev('warning');
              }}
            >
              Warnings
            </Chip>
            <Chip
              active={sev === 'info'}
              onClick={() => {
                setSev('info');
              }}
            >
              Info
            </Chip>
            <span className={styles.spacer} />
            <Chip
              active={src === 'all'}
              onClick={() => {
                setSrc('all');
              }}
            >
              Any source
            </Chip>
            <Chip
              active={src === 'client'}
              onClick={() => {
                setSrc('client');
              }}
            >
              Client
            </Chip>
            <Chip
              active={src === 'server'}
              onClick={() => {
                setSrc('server');
              }}
            >
              Server
            </Chip>
          </div>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No issues match the current filter.</div>
          ) : (
            <ul className={styles.list}>
              {filtered.map(i => (
                <li key={i.id} className={styles[`row_${i.severity}`]}>
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => {
                      onFocusIssue(i);
                    }}
                  >
                    <span className={styles.sev}>{i.severity}</span>
                    <span className={styles.rule}>{i.rule}</span>
                    <span className={styles.msg}>{i.message}</span>
                    {i.path.nodeId ? (
                      <span className={styles.target}>
                        → {i.path.nodeId}
                        {i.path.field ? `.${i.path.field}` : ''}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Pill({ severity, count }: { severity: Severity; count: number }): ReactElement | null {
  if (count === 0) return null;
  const label = `${count} ${severity}${count === 1 ? '' : 's'}`;
  return <span className={`${styles.pill} ${styles[`pill_${severity}`]}`}>● {label}</span>;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${styles.chip} ${active ? styles.chip_active : ''}`}
    >
      {children}
    </button>
  );
}
