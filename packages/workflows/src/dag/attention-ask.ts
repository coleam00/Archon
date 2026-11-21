import type { NodeOutput } from '../schemas';
import {
  type AttentionLabels,
  type AttentionOption,
  type AttentionRecommendation,
  type WaitCondition,
} from '../schemas/wait-node';
import { resolveAttentionDeclaration } from './references';

/** The operator-facing ask, resolved without opening or recording a pause. */
export function resolveAttentionAsk(
  nodeId: string,
  condition: Extract<WaitCondition, { kind: 'attention' }>,
  nodeOutputs: ReadonlyMap<string, NodeOutput>,
  render: (text: string) => string
): {
  message: string;
  options?: AttentionOption[];
  recommendation?: AttentionRecommendation;
  labels?: AttentionLabels;
} {
  const message = render(condition.message).trim();
  if (message === '') {
    throw new Error(`Wait node '${nodeId}' resolved 'attention' to an empty message`);
  }
  const { options, recommendation } = resolveAttentionDeclaration(nodeId, condition, nodeOutputs);
  const labels =
    condition.labels === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(condition.labels).map(([key, value]) => [key, render(value)])
        );
  return {
    message,
    ...(options !== undefined ? { options } : {}),
    ...(recommendation !== undefined ? { recommendation } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}
