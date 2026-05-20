import { CmEditor, Field } from '../../components/inspector/shared';
import { useWhenContext } from '../../components/when/useWhenContext';
import type { InspectorProps } from '../shared/types';
import { GeneralTab } from '../shared/GeneralTab';
import type { ApprovalNodeData } from './data';

/**
 * Patches into the nested `approval` object emit `{ approval: { field: ... } }`
 * so mergePatch deep-merges and sibling fields the inspector doesn't touch
 * survive (foreign keys preserved per §6.3 forward-compat invariant).
 */
export function ApprovalInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<ApprovalNodeData>): JSX.Element {
  const patchApproval = (patch: Record<string, unknown>): void => {
    onChange({ approval: patch });
  };
  const a = data.approval;
  const { extensions } = useWhenContext(id);

  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="approval.message">
        <Field
          label="Message"
          hint="Shown to the human reviewer when execution pauses. Type $ for upstream references."
        >
          <CmEditor
            ariaLabel="Message"
            value={a.message ?? ''}
            onChange={next => {
              patchApproval({ message: next });
            }}
            extensions={extensions}
            minHeight={80}
          />
        </Field>
      </div>
      <Field
        label="Capture response"
        htmlFor={`approval-cap-${id}`}
        hint="When true, the reviewer's text is captured into output."
      >
        <input
          id={`approval-cap-${id}`}
          aria-label="Capture response"
          type="checkbox"
          checked={a.capture_response ?? false}
          onChange={e => {
            patchApproval({ capture_response: e.target.checked || null });
          }}
        />
      </Field>
      <Field
        label="On reject — prompt"
        hint="Optional follow-up prompt shown when the reviewer rejects."
      >
        <CmEditor
          ariaLabel="On reject prompt"
          value={a.on_reject?.prompt ?? ''}
          onChange={next => {
            patchApproval({ on_reject: next === '' ? null : { prompt: next } });
          }}
          extensions={extensions}
          minHeight={60}
        />
      </Field>
    </GeneralTab>
  );
}
