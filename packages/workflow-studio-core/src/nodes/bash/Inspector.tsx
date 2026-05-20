import { CmEditor, Field } from '../../components/inspector/shared';
import { useWhenContext } from '../../components/when/useWhenContext';
import { GeneralTab } from '../shared/GeneralTab';
import { inputStyle } from '../shared/inspectorStyles';
import type { InspectorProps } from '../shared/types';
import type { BashNodeData } from './data';

export function BashInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<BashNodeData>): JSX.Element {
  const { extensions } = useWhenContext(id);
  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="bash">
        <Field
          label="Bash"
          hint="Shell script body. Runs via the bash runtime. Type $ for upstream node references."
        >
          <CmEditor
            ariaLabel="Bash"
            value={data.bash ?? ''}
            onChange={next => {
              onChange({ bash: next });
            }}
            extensions={extensions}
            minHeight={140}
          />
        </Field>
      </div>
      <Field
        label="Timeout (ms)"
        htmlFor={`bash-timeout-${id}`}
        hint="Execution timeout. Empty = runtime default."
      >
        <input
          id={`bash-timeout-${id}`}
          aria-label="Timeout"
          type="number"
          min={0}
          value={data.timeout ?? ''}
          onChange={e => {
            const v = e.target.value;
            onChange({ timeout: v === '' ? null : Number(v) });
          }}
          style={inputStyle}
        />
      </Field>
    </GeneralTab>
  );
}
