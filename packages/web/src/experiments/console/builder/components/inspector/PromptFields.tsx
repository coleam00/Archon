/** Inspector sub-form for prompt nodes. */
import type { ReactElement } from 'react';
import type { PromptNodeData } from '../../types';
import { TextAreaField } from './fields';

export function PromptFields({
  data,
  onChange,
}: {
  data: PromptNodeData;
  onChange: (next: PromptNodeData) => void;
}): ReactElement {
  return (
    <TextAreaField
      label="Prompt"
      value={data.prompt}
      rows={6}
      placeholder="What should the agent do?"
      onChange={(prompt): void => {
        onChange({ ...data, prompt });
      }}
    />
  );
}
