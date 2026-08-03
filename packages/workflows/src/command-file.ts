import type { DagNode } from './schemas';
import { isCommandNode, isLoopNode } from './schemas';

/** Return the command-file name used by a node, including deferred loop prompts. */
export function getFileBackedCommandName(node: DagNode): string | undefined {
  if (isCommandNode(node)) return node.command;
  if (isLoopNode(node) && typeof node.loop.command === 'string') return node.loop.command;
  return undefined;
}
