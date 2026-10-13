import type { AgentNode, GateNode } from './schemas';

export function gateReworkNode(node: GateNode, prompt: string): AgentNode {
  return {
    id: `${node.id}:on_reject`,
    kind: 'agent',
    source: { kind: 'inline', prompt },
    ...(node.depends_on ? { depends_on: node.depends_on } : {}),
    ...(node.idle_timeout ? { idle_timeout: node.idle_timeout } : {}),
  };
}
