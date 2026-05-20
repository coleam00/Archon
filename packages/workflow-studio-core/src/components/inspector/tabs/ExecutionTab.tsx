import type { CSSProperties } from 'react';
import type { InspectorProps } from '../../../nodes/shared/types';
import { Field, JsonField } from '../shared';
import { inputStyle, selectStyle } from '../../../nodes/shared/inspectorStyles';

interface Props extends InspectorProps<unknown> {
  forbidsRetry: boolean;
}

interface RetryShape {
  max_attempts?: number;
  delay_ms?: number;
  on_error?: 'transient' | 'all';
}

/**
 * Shared base-field tab. Renders execution-flow base fields:
 *   - idle_timeout (the base "timeout" knob — distinct from variant-specific
 *     `timeout` rendered in bash/script General Inspectors)
 *   - retry (max_attempts / delay_ms / on_error — gated on forbidsRetry)
 *   - sandbox (JSON editor — sandboxSettingsSchema is a passthrough object)
 *
 * Drift §8: the plan's `timeout`/`on_failure`/`on_timeout` and `retry.max`
 * are not real base fields. This tab renders the actual schema shape.
 */
export function ExecutionTab({ base, onChange, forbidsRetry }: Props): JSX.Element {
  const idleTimeout = base.idle_timeout as number | undefined;
  const retry = (base.retry as RetryShape | undefined) ?? {};

  return (
    <>
      <Field
        label="Idle timeout (seconds)"
        htmlFor="exec-idle-timeout"
        hint="Empty = inherit workflow default."
      >
        <input
          id="exec-idle-timeout"
          aria-label="Idle timeout"
          type="number"
          min={0}
          value={idleTimeout ?? ''}
          onChange={e => {
            onChange({ idle_timeout: e.target.value === '' ? null : Number(e.target.value) });
          }}
          style={inputStyle}
        />
      </Field>
      {forbidsRetry ? (
        <div role="note" style={bannerStyle}>
          Loop variants forbid retry — use loop.iteration_limit instead.
        </div>
      ) : null}
      <Field label="Retry max attempts" htmlFor="retry-max-attempts" hint="1–5. Empty = no retry.">
        <input
          id="retry-max-attempts"
          aria-label="Retry max attempts"
          type="number"
          min={1}
          max={5}
          disabled={forbidsRetry}
          value={retry.max_attempts ?? ''}
          onChange={e => {
            onChange({
              retry: { max_attempts: e.target.value === '' ? null : Number(e.target.value) },
            });
          }}
          style={inputStyle}
        />
      </Field>
      <Field
        label="Retry delay (ms)"
        htmlFor="retry-delay-ms"
        hint="1000–60000. Doubled on each attempt."
      >
        <input
          id="retry-delay-ms"
          aria-label="Retry delay"
          type="number"
          min={1000}
          max={60000}
          disabled={forbidsRetry}
          value={retry.delay_ms ?? ''}
          onChange={e => {
            onChange({
              retry: { delay_ms: e.target.value === '' ? null : Number(e.target.value) },
            });
          }}
          style={inputStyle}
        />
      </Field>
      <Field label="Retry on error" htmlFor="retry-on-error">
        <select
          id="retry-on-error"
          aria-label="Retry on error"
          disabled={forbidsRetry}
          value={retry.on_error ?? ''}
          onChange={e => {
            onChange({
              retry: {
                on_error: e.target.value === '' ? null : (e.target.value as 'transient' | 'all'),
              },
            });
          }}
          style={selectStyle}
        >
          <option value="">(default: transient)</option>
          <option value="transient">transient</option>
          <option value="all">all</option>
        </select>
      </Field>
      <JsonField
        label="Sandbox"
        value={base.sandbox ?? {}}
        onChange={v => {
          onChange({ sandbox: v && Object.keys(v as object).length ? v : null });
        }}
        hint="Claude Agent SDK SandboxSettings — passthrough object. See SDK docs."
      />
    </>
  );
}

const bannerStyle: CSSProperties = {
  padding: 8,
  marginBottom: 12,
  fontSize: 12,
  color: 'var(--studio-muted)',
  background: 'var(--studio-bg-elevated)',
  border: '1px dashed var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
