import type { DagNode } from '../../schemas';
import type { BashNodeData } from './data';

export function bashToDag(data: BashNodeData): Partial<DagNode> {
  const out: Record<string, unknown> = { bash: data.bash };
  if (data.timeout !== undefined) out.timeout = data.timeout;
  return out as Partial<DagNode>;
}
