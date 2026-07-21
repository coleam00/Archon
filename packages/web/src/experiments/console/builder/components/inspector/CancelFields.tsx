/** Inspector sub-form for cancel nodes. */
import type { ReactElement } from 'react';
import type { CancelNodeData } from '../../types';
import { TextAreaField } from './fields';

export function CancelFields({
  data,
  onChange,
}: {
  data: CancelNodeData;
  onChange: (next: CancelNodeData) => void;
}): ReactElement {
  return (
    <TextAreaField
      label="Cancellation reason"
      value={data.reason}
      rows={3}
      placeholder="Nothing to do — issue already closed."
      onChange={(reason): void => {
        onChange({ ...data, reason });
      }}
    />
  );
}
