/** Inspector sub-form for durable wait nodes. */
import type { ReactElement } from 'react';
import type { WaitNodeData } from '../../types';
import { NumberField, SelectField, TextField } from './fields';

type WaitMode = 'duration' | 'until' | 'event';

function modeOf(data: WaitNodeData): WaitMode {
  if (data.until !== undefined) return 'until';
  if (data.event !== undefined) return 'event';
  return 'duration';
}

export function WaitFields({
  data,
  onChange,
}: {
  data: WaitNodeData;
  onChange: (next: WaitNodeData) => void;
}): ReactElement {
  const mode = modeOf(data);
  return (
    <>
      <SelectField
        label="Wait for"
        value={mode}
        options={[
          { value: 'duration', label: 'Duration' },
          { value: 'until', label: 'Timestamp' },
          { value: 'event', label: 'Event' },
        ]}
        onChange={(next): void => {
          onChange(
            next === 'until'
              ? { until: '' }
              : next === 'event'
                ? { event: '', deadline_ms: 86_400_000 }
                : { duration_ms: 60_000 }
          );
        }}
      />
      {mode === 'duration' ? (
        <NumberField
          label="Duration (ms)"
          value={data.duration_ms}
          onChange={(duration_ms): void => {
            onChange({ duration_ms });
          }}
        />
      ) : mode === 'until' ? (
        <TextField
          label="ISO timestamp"
          value={data.until ?? ''}
          placeholder="2026-08-25T22:00:00Z"
          mono
          onChange={(until): void => {
            onChange({ until });
          }}
        />
      ) : (
        <>
          <TextField
            label="Event name"
            value={data.event ?? ''}
            placeholder="checks.complete"
            mono
            onChange={(event): void => {
              onChange({ event, deadline_ms: data.deadline_ms });
            }}
          />
          <NumberField
            label="Deadline (ms)"
            value={data.deadline_ms}
            onChange={(deadline_ms): void => {
              onChange({ event: data.event ?? '', deadline_ms });
            }}
          />
        </>
      )}
    </>
  );
}
