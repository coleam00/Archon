import type { persistNodeEvent, recordNodeState } from './node-event-write';
import type { IWorkflowStore, NodeStateEventType } from './store';

type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;

/** Every node-state variant is rejected by the production best-effort route. */
export type NodeStateCannotBeBestEffort = AssertNever<
  Extract<NodeStateEventType, Parameters<IWorkflowStore['createWorkflowEvent']>[0]['event_type']>
>;

/** The node writer admits all node states and no unrelated event kinds. */
export type NodeWriterAcceptsEveryState = AssertNever<
  Exclude<NodeStateEventType, Parameters<typeof persistNodeEvent>[1]['event_type']>
>;
export type NodeWriterRejectsOtherEvents = AssertNever<
  Exclude<Parameters<typeof persistNodeEvent>[1]['event_type'], NodeStateEventType>
>;

/** recordNodeState admits all node states and no unrelated event kinds. */
export type RecordNodeStateAcceptsEveryState = AssertNever<
  Exclude<NodeStateEventType, Parameters<typeof recordNodeState>[2]['event_type']>
>;
export type RecordNodeStateRejectsOtherEvents = AssertNever<
  Exclude<Parameters<typeof recordNodeState>[2]['event_type'], NodeStateEventType>
>;

/** General durable writes also own non-node evidence such as the fan-out snapshot. */
export type DurableWriterAcceptsFanOutSnapshot = AssertTrue<
  'fan_out_instances' extends Parameters<IWorkflowStore['persistWorkflowEvent']>[0]['event_type']
    ? true
    : false
>;
