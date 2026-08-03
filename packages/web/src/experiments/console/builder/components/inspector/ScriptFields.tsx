/** Inspector sub-form for script nodes (inline or named, bun/uv runtime). */
import type { ReactElement } from 'react';
import type { ScriptNodeData } from '../../types';
import { NumberField, SelectField, TextAreaField, TextField } from './fields';

export function ScriptFields({
  data,
  onChange,
}: {
  data: ScriptNodeData;
  onChange: (next: ScriptNodeData) => void;
}): ReactElement {
  return (
    <>
      <TextAreaField
        label="Script (inline or .archon/scripts name)"
        value={data.script}
        rows={5}
        placeholder="process.stdout.write(JSON.stringify({ ok: true }))"
        onChange={(script): void => {
          onChange({ ...data, script });
        }}
      />
      <SelectField
        label="Runtime"
        value={data.runtime}
        options={[
          { value: 'bun', label: 'bun (TypeScript / JavaScript)' },
          { value: 'uv', label: 'uv (Python)' },
        ]}
        onChange={(runtime): void => {
          onChange({ ...data, runtime: runtime === 'uv' ? 'uv' : 'bun' });
        }}
      />
      <TextField
        label="Deps (comma-separated)"
        value={(data.deps ?? []).join(', ')}
        mono
        placeholder="zod, yaml"
        onChange={(raw): void => {
          const deps = raw
            .split(',')
            .map(d => d.trim())
            .filter(d => d.length > 0);
          onChange({ ...data, deps: deps.length > 0 ? deps : undefined });
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
