import type { components } from './api.generated';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type WireNode = components['schemas']['DagNode'];
type FanOut<Parallelism> = {
  items: '$list.output';
  as: 'item';
  max_parallel: Parallelism;
  join: 'all_done';
};

type WorkflowNode<Parallelism> = {
  id: 'questions';
  workflow: 'question';
  fan_out: FanOut<Parallelism>;
};
type IncludeNode<Parallelism> = {
  id: 'work';
  include: 'block';
  fan_out: FanOut<Parallelism>;
};

export type WorkflowAllowsAll = AssertTrue<WorkflowNode<'all'> extends WireNode ? true : false>;
export type IncludeRejectsAll = AssertFalse<IncludeNode<'all'> extends WireNode ? true : false>;
export type WorkflowAllowsNumeric = AssertTrue<WorkflowNode<2> extends WireNode ? true : false>;
export type IncludeAllowsNumeric = AssertTrue<IncludeNode<2> extends WireNode ? true : false>;
