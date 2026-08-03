/** Inspector sub-form for approval (human gate) nodes. */
import type { ReactElement } from 'react';
import type { ApprovalNodeData } from '../../types';
import { CheckboxField, NumberField, TextAreaField } from './fields';

export function ApprovalFields({
  data,
  onChange,
}: {
  data: ApprovalNodeData;
  onChange: (next: ApprovalNodeData) => void;
}): ReactElement {
  return (
    <>
      <TextAreaField
        label="Message shown to the approver"
        value={data.message}
        rows={3}
        placeholder="Approve the plan before implementation?"
        onChange={(message): void => {
          onChange({ ...data, message });
        }}
      />
      <CheckboxField
        label="Capture the approver's response as output"
        checked={data.capture_response ?? false}
        onChange={(checked): void => {
          onChange({ ...data, capture_response: checked ? true : undefined });
        }}
      />
      <CheckboxField
        label="On reject: retry with feedback"
        checked={data.on_reject !== undefined}
        onChange={(checked): void => {
          onChange({
            ...data,
            on_reject: checked ? { prompt: data.on_reject?.prompt ?? '' } : undefined,
          });
        }}
      />
      {data.on_reject !== undefined ? (
        <>
          <TextAreaField
            label="On-reject prompt ($REJECTION_REASON available)"
            value={data.on_reject.prompt}
            rows={3}
            placeholder="Address the reviewer feedback: $REJECTION_REASON"
            onChange={(prompt): void => {
              onChange({ ...data, on_reject: { ...data.on_reject, prompt } });
            }}
          />
          <NumberField
            label="Max attempts"
            value={data.on_reject.max_attempts}
            placeholder="default"
            onChange={(max): void => {
              onChange({
                ...data,
                on_reject: {
                  prompt: data.on_reject?.prompt ?? '',
                  max_attempts: max,
                },
              });
            }}
          />
        </>
      ) : null}
    </>
  );
}
