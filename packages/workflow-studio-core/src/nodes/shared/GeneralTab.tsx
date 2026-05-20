import type { CSSProperties, ReactNode } from 'react';
import { DependsOnEditor, Field } from '../../components/inspector/shared';
import { WhenSection } from '../../components/when/WhenSection';
import { useWhenContext } from '../../components/when/useWhenContext';
import { TRIGGER_RULES } from '../../schemas';
import { useBuilderStore } from '../../store/builder-store';

interface Props {
  base: Record<string, unknown>;
  siblingIds: string[];
  onChange: (patch: Record<string, unknown>) => void;
  /** Variant-specific body fields rendered above the shared base fields. */
  children: ReactNode;
}

/**
 * Shared frame for the General tab. Variant-specific body fields render
 * first (passed via children); shared base-field controls — depends_on,
 * when (raw textarea — Phase 5 swaps in a visual builder), trigger_rule —
 * render below. All shared fields read from and write to `n.base`; the
 * store action routes them automatically via pickBaseFields.
 *
 * Per-node `description` is not part of the schema (only workflow.meta.description
 * exists), so this tab does not render one — see drift notes §3.
 */
export function GeneralTab({ base, siblingIds, onChange, children }: Props): JSX.Element {
  const dependsOn = (base.depends_on as string[] | undefined) ?? [];
  const when = (base.when as string | undefined) ?? '';
  const triggerRule = (base.trigger_rule as string | undefined) ?? 'all_success';

  // Upstream-aware autocomplete context is sourced from the store via the
  // hook, so WhenSection reflects the current workflow without prop drilling.
  const selectedId = useBuilderStore(s => s.primarySelectionId) ?? '';
  const { upstreamIds, outputFormatLookup } = useWhenContext(selectedId);

  return (
    <>
      {children}
      <DependsOnEditor
        value={dependsOn}
        siblingIds={siblingIds}
        onChange={next => {
          onChange({ depends_on: next.length === 0 ? null : next });
        }}
      />
      <WhenSection
        value={when || undefined}
        upstreamIds={upstreamIds}
        outputFormatLookup={outputFormatLookup}
        onChange={next => {
          onChange({ when: next });
        }}
      />
      <Field
        label="Trigger rule"
        htmlFor="gt-trigger"
        hint="all_success (default), one_success, none_failed_min_one_success, all_done."
      >
        <select
          id="gt-trigger"
          value={triggerRule}
          onChange={e => {
            onChange({ trigger_rule: e.target.value === 'all_success' ? null : e.target.value });
          }}
          style={selectStyle}
        >
          {TRIGGER_RULES.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

const selectStyle: CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  background: 'var(--studio-bg-elevated)',
  color: 'var(--studio-fg)',
  border: '1px solid var(--studio-border)',
  borderRadius: 'var(--radius-sm)',
};
