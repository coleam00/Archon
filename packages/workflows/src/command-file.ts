import type { DagNode } from './schemas';
import { isCommandNode, isLoopGroupNode, isLoopNode } from './schemas';

/** Return the command-file name used by a node, including deferred loop prompts. */
export function getFileBackedCommandName(node: DagNode): string | undefined {
  if (isCommandNode(node)) return node.command;
  if (isLoopNode(node) && typeof node.loop.command === 'string') return node.loop.command;
  return undefined;
}

/** Collect command-file names from a node list, including nested loop-group bodies. */
export function collectFileBackedCommandNames(nodes: readonly DagNode[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: DagNode): void => {
    const commandName = getFileBackedCommandName(node);
    if (commandName !== undefined) names.add(commandName);
    if (isLoopGroupNode(node)) {
      for (const child of node.loop_group.nodes) visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return names;
}
