/** Inspector sub-form for loop nodes. */
import type { ReactElement } from 'react';
import type { LoopNodeData } from '../../types';
import { CheckboxField, NumberField, SelectField, TextAreaField, TextField } from './fields';

export function LoopFields({
  data,
  onChange,
}: {
  data: LoopNodeData;
  onChange: (next: LoopNodeData) => void;
}): ReactElement {
  // Exactly-one prompt source (engine one-of rule): the toggle swaps which
  // field is present, dropping the other so a stale value can never leak into
  // the export. `command` keys the mode (matching loopToDag's export branch);
  // the importer guarantees at most one of the two is present on `data`.
  const sourceMode: 'prompt' | 'command' = data.command !== undefined ? 'command' : 'prompt';
  return (
    <>
      <SelectField
        label="Prompt source"
        value={sourceMode}
        options={[
          { value: 'prompt', label: 'Inline prompt' },
          { value: 'command', label: 'Command file' },
        ]}
        onChange={(next): void => {
          if (next === sourceMode) return;
          const rest: LoopNodeData = { ...data };
          delete rest.prompt;
          delete rest.command;
          onChange(next === 'command' ? { ...rest, command: '' } : { ...rest, prompt: '' });
        }}
      />
      {sourceMode === 'command' ? (
        <TextField
          label="Command (each iteration)"
          value={data.command ?? ''}
          mono
          placeholder="my-command"
          onChange={(command): void => {
            onChange({ ...data, command });
          }}
        />
      ) : (
        <TextAreaField
          label="Prompt (each iteration)"
          value={data.prompt ?? ''}
          rows={5}
          placeholder="Keep fixing failing tests…"
          onChange={(prompt): void => {
            onChange({ ...data, prompt });
          }}
        />
      )}
      <TextField
        label="Until (completion signal)"
        value={data.until}
        mono
        placeholder="COMPLETE"
        onChange={(until): void => {
          onChange({ ...data, until });
        }}
      />
      <TextField
        label="Until bash (optional check)"
        value={data.until_bash ?? ''}
        mono
        placeholder="bun run validate"
        onChange={(raw): void => {
          onChange({ ...data, until_bash: raw.length > 0 ? raw : undefined });
        }}
      />
      <NumberField
        label="Max iterations"
        value={data.max_iterations}
        onChange={(max): void => {
          if (max !== undefined) onChange({ ...data, max_iterations: max });
        }}
      />
      <CheckboxField
        label="Fresh context each iteration"
        checked={data.fresh_context}
        onChange={(fresh_context): void => {
          onChange({ ...data, fresh_context });
        }}
      />
      <CheckboxField
        label="Interactive gate between iterations"
        checked={data.interactive ?? false}
        onChange={(checked): void => {
          onChange({ ...data, interactive: checked ? true : undefined });
        }}
      />
      {data.interactive === true ? (
        <TextField
          label="Gate message"
          value={data.gate_message ?? ''}
          placeholder="Continue with the next iteration?"
          onChange={(raw): void => {
            onChange({ ...data, gate_message: raw.length > 0 ? raw : undefined });
          }}
        />
      ) : null}
    </>
  );
}
