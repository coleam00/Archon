/** Inspector sub-form for bash nodes. */
import type { ReactElement } from 'react';
import type { BashNodeData } from '../../types';
import { NumberField, TextAreaField } from './fields';

export function BashFields({
  data,
  onChange,
}: {
  data: BashNodeData;
  onChange: (next: BashNodeData) => void;
}): ReactElement {
  return (
    <>
      <TextAreaField
        label="Script"
        value={data.bash}
        rows={5}
        placeholder="echo 'hello'"
        onChange={(bash): void => {
          onChange({ ...data, bash });
        }}
      />
      <NumberField
        label="Timeout (ms)"
        value={data.timeout}
        placeholder="default"
        onChange={(timeout): void => {
          onChange({ ...data, timeout });
        }}
      />
    </>
  );
}
