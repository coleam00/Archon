import { Field } from '../../components/inspector/shared';
import type { InspectorProps } from '../shared/types';
import { GeneralTab } from '../shared/GeneralTab';
import { textareaStyle } from '../shared/inspectorStyles';
import type { CancelNodeData } from './data';

export function CancelInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<CancelNodeData>): JSX.Element {
  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="cancel">
        <Field
          label="Cancel reason"
          htmlFor={`cancel-${id}`}
          hint="Reason string shown when this node terminates the workflow."
        >
          <textarea
            id={`cancel-${id}`}
            aria-label="Cancel reason"
            value={data.cancel ?? ''}
            onChange={e => {
              onChange({ cancel: e.target.value });
            }}
            rows={3}
            style={textareaStyle}
          />
        </Field>
      </div>
    </GeneralTab>
  );
}
