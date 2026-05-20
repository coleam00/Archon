import { CmEditor, Field } from '../../components/inspector/shared';
import { useWhenContext } from '../../components/when/useWhenContext';
import { GeneralTab } from '../shared/GeneralTab';
import { inputStyle, selectStyle, textareaStyle } from '../shared/inspectorStyles';
import type { InspectorProps } from '../shared/types';
import type { ScriptNodeData } from './data';

export function ScriptInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<ScriptNodeData>): JSX.Element {
  const { extensions } = useWhenContext(id);
  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="script">
        <Field
          label="Script"
          hint="Inline source. TypeScript runs via Bun, Python via uv. Type $ for upstream references."
        >
          <CmEditor
            ariaLabel="Script"
            value={data.script ?? ''}
            onChange={next => {
              onChange({ script: next });
            }}
            extensions={extensions}
            minHeight={140}
          />
        </Field>
      </div>
      <Field label="Runtime" htmlFor={`script-runtime-${id}`}>
        <select
          id={`script-runtime-${id}`}
          aria-label="Runtime"
          value={data.runtime ?? 'bun'}
          onChange={e => {
            onChange({ runtime: e.target.value });
          }}
          style={selectStyle}
        >
          <option value="bun">bun (TypeScript)</option>
          <option value="uv">uv (Python)</option>
        </select>
      </Field>
      <Field label="Deps" hint="One per line. Passed to the runtime's dependency installer.">
        <textarea
          aria-label="Deps"
          value={(data.deps ?? []).join('\n')}
          onChange={e => {
            const lines = e.target.value
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            onChange({ deps: lines.length === 0 ? null : lines });
          }}
          rows={3}
          style={textareaStyle}
        />
      </Field>
      <Field
        label="Timeout (ms)"
        htmlFor={`script-timeout-${id}`}
        hint="Execution timeout. Empty = runtime default."
      >
        <input
          id={`script-timeout-${id}`}
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
