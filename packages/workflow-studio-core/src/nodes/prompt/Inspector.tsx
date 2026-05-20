import { CmEditor, Field } from '../../components/inspector/shared';
import { useWhenContext } from '../../components/when/useWhenContext';
import { GeneralTab } from '../shared/GeneralTab';
import type { InspectorProps } from '../shared/types';
import type { PromptNodeData } from './data';

export function PromptInspector({
  id,
  data,
  base,
  onChange,
  siblingIds,
}: InspectorProps<PromptNodeData>): JSX.Element {
  const { extensions } = useWhenContext(id);
  return (
    <GeneralTab base={base} siblingIds={siblingIds} onChange={onChange}>
      <div data-field="prompt">
        <Field label="Prompt" hint="Inline prompt body. Type $ for upstream node references.">
          <CmEditor
            ariaLabel="Prompt"
            value={data.prompt ?? ''}
            onChange={next => {
              onChange({ prompt: next });
            }}
            extensions={extensions}
            minHeight={140}
          />
        </Field>
      </div>
    </GeneralTab>
  );
}
