import type { DagNode } from '../../schemas';
import type { PromptNodeData } from './data';

export function promptToDag(data: PromptNodeData): Partial<DagNode> {
  return { prompt: data.prompt } as Partial<DagNode>;
}
