import type { DagNode } from '../../schemas';
import type { ScriptNodeData } from './data';

export function scriptToDag(data: ScriptNodeData): Partial<DagNode> {
  const out: Record<string, unknown> = { script: data.script, runtime: data.runtime };
  if (Array.isArray(data.deps)) out.deps = data.deps;
  if (data.timeout !== undefined) out.timeout = data.timeout;
  return out as Partial<DagNode>;
}
