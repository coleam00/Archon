import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { format, parse, toDnf, type DnfAst } from '../../lib/grammar';
import { CmEditor, Field } from '../inspector/shared';
import { WhenBuilder } from './WhenBuilder';
import { whenAutocompleteExtension } from './completions';

interface Props {
  /** Current `when:` string (empty / undefined -> empty). */
  value: string | undefined;
  upstreamIds: readonly string[];
  outputFormatLookup: (nodeId: string) => Record<string, unknown> | null;
  /** Patch emitter; null clears the field (matches GeneralTab semantics). */
  onChange: (next: string | null) => void;
}

type Mode = 'visual' | 'raw';

interface Derived {
  parsedDnf: DnfAst | null;
  parseError: string | null;
}

function derive(value: string | undefined): Derived {
  if (!value || value.trim() === '') {
    return { parsedDnf: { kind: 'or', children: [] }, parseError: null };
  }
  const r = parse(value);
  if (!r.ok) return { parsedDnf: null, parseError: r.error };
  return { parsedDnf: toDnf(r.ast), parseError: null };
}

function formatDnf(dnf: DnfAst): string | null {
  if (dnf.children.length === 0) return null;
  if (dnf.children.length === 1) {
    const only = dnf.children[0];
    if (only.children.length === 0) return null;
    if (only.children.length === 1) return format(only.children[0]);
    return format(only);
  }
  return format(dnf);
}

export function WhenSection({
  value,
  upstreamIds,
  outputFormatLookup,
  onChange,
}: Props): JSX.Element {
  const derived = useMemo(() => derive(value), [value]);
  const visualAvailable = derived.parsedDnf !== null && derived.parseError === null;
  const [mode, setMode] = useState<Mode>(visualAvailable ? 'visual' : 'raw');

  useEffect(() => {
    if (!visualAvailable && mode === 'visual') setMode('raw');
  }, [visualAvailable, mode]);

  const extensions = useMemo(
    () => [whenAutocompleteExtension({ upstreamIds, outputFormatLookup })],
    [upstreamIds, outputFormatLookup]
  );

  const hint = derived.parseError
    ? 'Raw mode only — expression has a parse error.'
    : derived.parsedDnf === null
      ? 'Raw mode only — expression is outside DNF.'
      : "Switch to Raw for ops or value types the visual builder doesn't expose.";

  return (
    <div data-field="when">
      <Field label="When" hint={hint}>
        <div style={toolbarStyle}>
          <button
            type="button"
            aria-pressed={mode === 'visual'}
            aria-label="Visual"
            disabled={!visualAvailable}
            onClick={() => {
              setMode('visual');
            }}
            style={toggleStyle(mode === 'visual', !visualAvailable)}
          >
            Visual
          </button>
          <button
            type="button"
            aria-pressed={mode === 'raw'}
            aria-label="Raw"
            onClick={() => {
              setMode('raw');
            }}
            style={toggleStyle(mode === 'raw', false)}
          >
            Raw
          </button>
        </div>

        {!visualAvailable && (
          <div role="status" style={bannerStyle}>
            {derived.parseError
              ? `Can't parse this expression: ${derived.parseError}. Edit raw, then re-try visual.`
              : 'Visual builder needs flat OR-of-ANDs. Edit raw, or simplify the expression.'}
          </div>
        )}

        {mode === 'visual' && derived.parsedDnf && (
          <WhenBuilder
            dnf={derived.parsedDnf}
            upstreamIds={upstreamIds}
            outputFormatLookup={outputFormatLookup}
            onChange={nextDnf => {
              onChange(formatDnf(nextDnf));
            }}
          />
        )}

        {mode === 'raw' && (
          <CmEditor
            ariaLabel="When (raw)"
            value={value ?? ''}
            onChange={next => {
              onChange(next === '' ? null : next);
            }}
            extensions={extensions}
            minHeight={48}
          />
        )}
      </Field>
    </div>
  );
}

const toolbarStyle: CSSProperties = { display: 'flex', gap: 4, marginBottom: 6 };
const bannerStyle: CSSProperties = {
  padding: '6px 8px',
  background: 'var(--studio-bg-elevated)',
  border: '1px dashed var(--studio-warn, #d97706)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 12,
  color: 'var(--studio-fg-muted)',
  marginBottom: 6,
};

function toggleStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 12,
    background: active ? 'var(--studio-accent, #2563eb)' : 'var(--studio-bg-elevated)',
    color: active ? '#fff' : 'var(--studio-fg)',
    border: '1px solid var(--studio-border)',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
