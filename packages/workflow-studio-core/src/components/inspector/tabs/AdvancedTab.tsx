import type { CSSProperties } from 'react';
import type { InspectorProps } from '../../../nodes/shared/types';
import { JsonField } from '../shared';
import { useBuilderStore } from '../../../store/builder-store';
import { defaultRegistry } from '../../../nodes/default-registry';

/**
 * Shared base-field tab for the two forward-compat "bags" + a capabilities
 * readout. Every variant gets this tab.
 *
 * Sections (drift §8):
 *   1. data._unknown — variant-specific forward-compat (where convertVariant
 *      stashes _converted_from). Edits route to data._unknown via
 *      `updateNodeData` since `_unknown` is variant-specific.
 *   2. n.unknown — top-level forward-compat (DagNode keys the studio's
 *      schema mirror doesn't recognise). Routed automatically.
 *   3. Variant capabilities readout — read-only debug view of the variant
 *      flags driving Inspector tab visibility and validator behaviour.
 */
export function AdvancedTab({ id, data, unknown, onChange }: InspectorProps<unknown>): JSX.Element {
  const variant = useBuilderStore(s => {
    const node = s.nodes.find(n => n.id === id);
    return node ? defaultRegistry[node.variant] : undefined;
  });
  const dataUnknown = (data as { _unknown?: Record<string, unknown> } | undefined)?._unknown ?? {};

  // `_unknown` is variant-data-private and not in BASE_FIELD_KEYS or any
  // VARIANT_SPECIFIC_KEYS list, so `updateNodeData` would route it to
  // `n.unknown` (wrong). Write through `updateNode` with an explicit data
  // patch instead — the bucket is `n.data._unknown`.
  const writeDataUnknown = (next: Record<string, unknown>): void => {
    const node = useBuilderStore.getState().nodes.find(n => n.id === id);
    if (!node) return;
    useBuilderStore.getState().updateNode(id, {
      data: { ...(node.data as Record<string, unknown>), _unknown: next },
    });
  };

  return (
    <>
      <JsonField
        label="Variant raw fields (data._unknown)"
        value={dataUnknown}
        onChange={v => {
          writeDataUnknown((v as Record<string, unknown>) ?? {});
        }}
        hint="Forward-compat bag for variant-specific keys the studio doesn't recognise. Edits replace this object wholesale."
      />
      <JsonField
        label="Top-level raw fields (node.unknown)"
        value={unknown}
        onChange={v => {
          const obj = (v as Record<string, unknown>) ?? {};
          // Compute a wholesale-replace patch: set keys present in v, null out
          // keys removed since the previous value. Routed to n.unknown via
          // pickBaseFields (none of these keys are base or variant-specific).
          const patch: Record<string, unknown> = { ...obj };
          for (const k of Object.keys(unknown)) {
            if (!(k in obj)) patch[k] = null;
          }
          onChange(patch);
        }}
        hint="Top-level DagNode keys the schema doesn't recognise. Edits replace this object wholesale; sub-keys removed here are deleted."
      />
      {variant ? (
        <div style={capsStyle}>
          <h4 style={capsHeadingStyle}>Variant capabilities</h4>
          <ul style={capsListStyle}>
            <li>
              honorsAiFields: <code>{String(variant.capabilities.honorsAiFields)}</code>
            </li>
            <li>
              forbidsRetry: <code>{String(variant.capabilities.forbidsRetry)}</code>
            </li>
            <li>
              requiresInteractive:{' '}
              <code>{String(Boolean(variant.capabilities.requiresInteractive))}</code>
            </li>
          </ul>
        </div>
      ) : null}
    </>
  );
}

const capsStyle: CSSProperties = {
  marginTop: 16,
  paddingTop: 12,
  borderTop: '1px solid var(--studio-border)',
};
const capsHeadingStyle: CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--studio-muted)',
  margin: '0 0 8px 0',
};
const capsListStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: 'var(--studio-fg)',
};
