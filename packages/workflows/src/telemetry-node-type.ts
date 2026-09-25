import type { WorkflowNodeType } from '@archon/paths';
import type { NodeDescriptor } from './schemas/node-execution';

/**
 * Closed-set node type for telemetry. Takes a persisted node descriptor; a live
 * `DagNode` carries the same discriminators and is accepted too.
 */
export function telemetryNodeType(node: NodeDescriptor): WorkflowNodeType {
  switch (node.kind) {
    case 'agent':
      return node.source.kind === 'command' ? 'command' : 'prompt';
    case 'exec':
      return node.runtime === 'sh' ? 'bash' : 'script';
    case 'loop':
      return 'loop';
    case 'loop_group':
      return 'loop_group';
    case 'gate':
      return 'approval';
    case 'wait':
      return 'wait';
    case 'halt':
      return 'cancel';
    case 'workflow':
      return 'workflow';
    case 'compose_fan_out':
    case 'compose_fan_out_instance':
      return 'compose_fan_out';
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
