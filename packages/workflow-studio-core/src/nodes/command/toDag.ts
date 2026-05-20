import type { DagNode } from '../../schemas';
import type { CommandNodeData } from './data';

export function commandToDag(data: CommandNodeData): Partial<DagNode> {
  return { command: data.command } as Partial<DagNode>;
}
