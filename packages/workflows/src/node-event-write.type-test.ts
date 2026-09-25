import type { NodeStateRecord } from './schemas/node-execution';
import type { persistNodeEvent, recordNodeState } from './node-event-write';
import type { IWorkflowStore, NodeStateEventType } from './store';

type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;

export type NodeStateCannotBeBestEffort = AssertNever<
  Extract<NodeStateEventType, Parameters<IWorkflowStore['createWorkflowEvent']>[0]['event_type']>
>;
export type NodeWriterAcceptsEveryState = AssertNever<
  Exclude<NodeStateEventType, Parameters<typeof persistNodeEvent>[1]['event_type']>
>;
export type NodeWriterRejectsOtherEvents = AssertNever<
  Exclude<Parameters<typeof persistNodeEvent>[1]['event_type'], NodeStateEventType>
>;
export type CanonicalWriterAcceptsRecord = AssertTrue<
  Parameters<typeof recordNodeState>[1] extends NodeStateRecord ? true : false
>;
export type DurableWriterAcceptsFanOutSnapshot = AssertTrue<
  'fan_out_instances' extends Parameters<IWorkflowStore['persistWorkflowEvent']>[0]['event_type']
    ? true
    : false
>;
