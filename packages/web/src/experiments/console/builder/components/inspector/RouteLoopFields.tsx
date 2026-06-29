/** Inspector sub-form for route-loop controller nodes. */
import type { ReactElement } from 'react';
import type { RouteLoopNodeData } from '../../types';
import { NumberField, TextField } from './fields';

export function RouteLoopFields({
  data,
  onChange,
}: {
  data: RouteLoopNodeData;
  onChange: (next: RouteLoopNodeData) => void;
}): ReactElement {
  return (
    <>
      <TextField
        label="From node"
        value={data.from}
        mono
        placeholder="implement"
        onChange={(from): void => {
          onChange({ ...data, from });
        }}
      />
      <TextField
        label="Condition"
        value={data.condition}
        mono
        placeholder="$implement.output contains COMPLETE"
        onChange={(condition): void => {
          onChange({ ...data, condition });
        }}
      />
      <NumberField
        label="Max iterations"
        value={data.max_iterations}
        onChange={(max_iterations): void => {
          if (max_iterations !== undefined) onChange({ ...data, max_iterations });
        }}
      />
      <TextField
        label="Positive route"
        value={data.routes.positive}
        mono
        placeholder="done"
        onChange={(positive): void => {
          onChange({ ...data, routes: { ...data.routes, positive } });
        }}
      />
      <TextField
        label="Negative route"
        value={data.routes.negative}
        mono
        placeholder="fix"
        onChange={(negative): void => {
          onChange({ ...data, routes: { ...data.routes, negative } });
        }}
      />
      <TextField
        label="Exhausted route"
        value={data.routes.exhausted}
        mono
        placeholder="fail"
        onChange={(exhausted): void => {
          onChange({ ...data, routes: { ...data.routes, exhausted } });
        }}
      />
    </>
  );
}
