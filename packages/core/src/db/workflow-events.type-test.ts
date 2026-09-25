import type { NodeStateEventType } from '@archon/workflows/store';
import type {
  createWorkflowEvent,
  insertWorkflowEvent,
  persistWorkflowEvent,
} from './workflow-events';

type AssertNever<Value extends never> = Value;
type AssertTrue<Value extends true> = Value;

/** Direct database callers cannot bypass the store's node-state durability boundary. */
export type DirectBestEffortRejectsNodeStates = AssertNever<
  Extract<NodeStateEventType, Parameters<typeof createWorkflowEvent>[0]['event_type']>
>;
export type DirectDurableAcceptsNodeStates = AssertNever<
  Exclude<NodeStateEventType, Parameters<typeof persistWorkflowEvent>[0]['event_type']>
>;
export type TransactionAcceptsFanOutSnapshot = AssertTrue<
  'fan_out_instances' extends Parameters<typeof insertWorkflowEvent>[1]['event_type'] ? true : false
>;
