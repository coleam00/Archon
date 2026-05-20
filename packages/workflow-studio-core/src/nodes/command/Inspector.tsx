import { Field } from '../../components/inspector/shared';
import type { InspectorProps } from '../shared/types';
import { GeneralTab } from '../shared/GeneralTab';
import { inputStyle } from '../shared/inspectorStyles';
import type { CommandNodeData } from './data';

export function CommandInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<CommandNodeData>): JSX.Element {
  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="command">
        <Field label="Command" htmlFor={`cmd-${id}`} hint="Name of a command in .archon/commands/.">
          <input
            id={`cmd-${id}`}
            aria-label="Command"
            value={data.command ?? ''}
            onChange={e => {
              onChange({ command: e.target.value });
            }}
            style={inputStyle}
          />
        </Field>
      </div>
    </GeneralTab>
  );
}
