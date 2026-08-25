/** Wait variant: defaults + sparse fromDag/toDag conversion. */
import type { BuilderDagFragment, WaitNodeData, WireDagNode } from '../types';

export function defaultWaitData(): WaitNodeData {
  return { duration_ms: 60_000 };
}

export function waitFromDag(variantSpecific: Partial<WireDagNode>): WaitNodeData {
  if (variantSpecific.wait === undefined) {
    throw new Error(
      "waitFromDag: wire node has no 'wait' field — use defaultWaitData() for new nodes"
    );
  }
  return { ...variantSpecific.wait };
}

export function waitToDag(data: WaitNodeData): BuilderDagFragment {
  return { wait: { ...data } };
}
