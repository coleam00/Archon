import type { AgentNode } from './agent-node';
import type { DagNode, LoopGroupNode } from './dag-node';
import type { ExecNode } from './exec-node';
import type { GateNode } from './gate-node';
import type { HaltNode } from './halt-node';
import type { ComposeFanOutNode, IncludeDirective } from './include-node';
import type { LoopNode } from './loop-node';
import type { WaitNode } from './wait-node';
import type { WorkflowNode } from './workflow-node';

/** Type guard: check if a DAG node is an agent (command-file or inline-prompt) node */
export function isAgentNode(node: DagNode): node is AgentNode {
  return node.kind === 'agent';
}

/** Type guard: check if a DAG node is an exec (bash or script) node */
export function isExecNode(node: DagNode): node is ExecNode {
  return node.kind === 'exec';
}

/** Type guard: check if a DAG node is a gate (human-in-the-loop) node */
export function isGateNode(node: DagNode): node is GateNode {
  return node.kind === 'gate';
}

/** Type guard: check if a DAG node is a durable world-wait node. */
export function isWaitNode(node: DagNode): node is WaitNode {
  return node.kind === 'wait';
}

/** Type guard: check if a DAG node is a halt (workflow termination) node */
export function isHaltNode(node: DagNode): node is HaltNode {
  return node.kind === 'halt';
}

/** Type guard: check if a DAG node is a loop (iterative) node */
export function isLoopNode(node: DagNode): node is LoopNode {
  return node.kind === 'loop';
}

/** Type guard: check if a DAG node is a loop_group (cross-node iterative subgraph) node */
export function isLoopGroupNode(node: DagNode): node is LoopGroupNode {
  return node.kind === 'loop_group';
}

/** Type guard: check if a DAG node is a workflow (runtime sub-run) node */
export function isWorkflowNode(node: DagNode): node is WorkflowNode {
  return node.kind === 'workflow';
}

/** Type guard: check if a node is a runtime-width composed fan-out (include + fan_out) */
export function isComposeFanOutNode(node: DagNode | IncludeDirective): node is ComposeFanOutNode {
  return node.kind === 'compose_fan_out';
}

/**
 * Type guard: check if a pre-expansion graph entry is an include directive rather
 * than an executable `DagNode`. Normalized includes have their own discriminant even
 * though they are not executable `DagNode`s (#2486).
 */
export function isIncludeDirective(node: DagNode | IncludeDirective): node is IncludeDirective {
  const candidate = node as { kind?: unknown; include?: unknown };
  return (
    candidate.kind === 'include' ||
    (candidate.kind === undefined && typeof candidate.include === 'string')
  );
}
