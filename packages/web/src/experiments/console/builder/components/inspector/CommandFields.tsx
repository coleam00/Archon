/** Inspector sub-form for command nodes. */
import type { ReactElement } from 'react';
import type { CommandNodeData } from '../../types';
import { TextField } from './fields';

export function CommandFields({
  data,
  onChange,
}: {
  data: CommandNodeData;
  onChange: (next: CommandNodeData) => void;
}): ReactElement {
  return (
    <TextField
      label="Command"
      value={data.command}
      mono
      placeholder="command-name [$1 $2 …]"
      onChange={(command): void => {
        onChange({ ...data, command });
      }}
    />
  );
}
