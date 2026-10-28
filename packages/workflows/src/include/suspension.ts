import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import {
  isComposeFanOutNode,
  isGateNode,
  isIncludeDirective,
  isLoopGroupNode,
  isLoopNode,
  isWaitNode,
  isWorkflowNode,
} from '../schemas';
import { resolveWorkflowName } from '../router';

export interface ComposedSuspensionPath {
  id: string;
  reason: string;
}

type SuspensionWorkflow = Pick<WorkflowDefinition, 'name'> & {
  readonly nodes: readonly (DagNode | IncludeDirective)[];
};

/**
 * Find every path in a static include/workflow closure that can pause an instance.
 * Composed fan-out currently owns one parent cursor, not one cursor per item, so both
 * load-time validation and the execution-time source-drift preflight use this proof.
 * Durable interactive instances are tracked separately in #2810.
 */
export function collectComposedSuspensionPaths(
  root: SuspensionWorkflow,
  definitions: readonly SuspensionWorkflow[]
): ComposedSuspensionPath[] {
  const byName = new Map(definitions.map(definition => [definition.name, definition]));
  const visited = new Set<string>();
  const found: ComposedSuspensionPath[] = [];

  const visitDefinition = (definition: SuspensionWorkflow): void => {
    if (visited.has(definition.name)) return;
    visited.add(definition.name);
    visitNodes(definition.nodes);
  };

  const visitTarget = (name: string, ownerId: string, kind: 'include' | 'workflow'): void => {
    let target: SuspensionWorkflow | undefined;
    try {
      target = kind === 'workflow' ? resolveWorkflowName(name, definitions) : byName.get(name);
    } catch (_err) {
      found.push({ id: ownerId, reason: `${kind} target '${name}' is ambiguous` });
      return;
    }
    if (target === undefined) {
      found.push({ id: ownerId, reason: `${kind} target '${name}' cannot be resolved` });
      return;
    }
    visitDefinition(target);
  };

  const visitNodes = (nodes: readonly (DagNode | IncludeDirective)[]): void => {
    for (const candidate of nodes) {
      if (isIncludeDirective(candidate)) {
        visitTarget(candidate.include, candidate.id, 'include');
        continue;
      }
      if (isGateNode(candidate)) {
        found.push({ id: candidate.id, reason: 'approval gate' });
      } else if (isWaitNode(candidate)) {
        found.push({ id: candidate.id, reason: 'durable wait' });
      } else if (isLoopNode(candidate) && candidate.loop.interactive === true) {
        found.push({ id: candidate.id, reason: 'interactive loop' });
      } else if (isLoopGroupNode(candidate)) {
        if (candidate.loop_group.interactive === true) {
          found.push({ id: candidate.id, reason: 'interactive loop group' });
        }
        visitNodes(candidate.loop_group.nodes);
      }

      if (isComposeFanOutNode(candidate)) {
        visitTarget(candidate.include, candidate.id, 'include');
      } else if (isWorkflowNode(candidate)) {
        visitTarget(candidate.workflow, candidate.id, 'workflow');
      }
    }
  };

  visitDefinition(root);
  return found;
}
